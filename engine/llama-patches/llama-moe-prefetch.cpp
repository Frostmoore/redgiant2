#include "llama-moe-prefetch.h"

#include "llama-impl.h"
#include "llama-model.h"

#include "ggml.h"

#include <algorithm>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

bool llama_moe_prefetch_requested() {
    const char * v = getenv("LLAMA_MOE_PREFETCH");
    return v != nullptr && strcmp(v, "1") == 0;
}

static bool is_host_weight(const ggml_tensor * t) {
    return t != nullptr && t->buffer != nullptr && ggml_backend_buffer_is_host(t->buffer) &&
           ggml_backend_buffer_get_usage(t->buffer) == GGML_BACKEND_BUFFER_USAGE_WEIGHTS;
}

// same type, shape and strides as src (the views are reused, their data stays in the slot)
static void shape_like(ggml_tensor * view, const ggml_tensor * src) {
    view->type = src->type;
    memcpy(view->ne, src->ne, sizeof(view->ne));
    memcpy(view->nb, src->nb, sizeof(view->nb));
}

struct llama_moe_prefetch::impl {
    struct job {
        int                 slot;
        const ggml_tensor * src;
        uint64_t            id;
    };

    struct slot {
        ggml_tensor * view_main   = nullptr; // touched only by the main thread
        ggml_tensor * view_upload = nullptr; // touched only by the worker

        ggml_backend_event_t ready = nullptr; // upload done (upload stream)
        ggml_backend_event_t freed = nullptr; // device-to-device copy out of the slot done (main stream)

        const ggml_tensor * held = nullptr; // tensor whose upload was queued into the slot
        uint64_t job = 0;
    };

    const llama_model & model;
    const bool debug = getenv("LLAMA_MOE_PREFETCH_DEBUG") != nullptr;

    ggml_backend_t main   = nullptr; // the context's backend, not owned
    ggml_backend_t upload = nullptr; // a second backend on the same device: its own stream

    ggml_backend_buffer_t buf = nullptr;
    size_t slot_size = 0;
    ggml_context * ctx = nullptr;
    std::vector<slot> slots;

    // the worker issues the uploads: from pageable memory (mmap) cudaMemcpyAsync blocks the caller,
    // so the main thread would not reach the compute of the current tensor until the copy ended
    std::thread worker;
    std::mutex mu;
    std::condition_variable cv;
    std::deque<job> jobs;
    uint64_t queued = 0;
    uint64_t issued = 0;
    bool stop = false;

    // order of the tensors of experts inside a layer, learned from the first layer seen
    std::vector<std::string> roles;
    int  roles_layer = -1;
    bool roles_done  = false;
    std::unordered_map<const ggml_tensor *, const ggml_tensor *> next_of;

    uint64_t n_hit = 0, n_miss = 0, bytes = 0;

    explicit impl(const llama_model & model) : model(model) {}

    ~impl() {
        if (worker.joinable()) {
            {
                std::lock_guard<std::mutex> lock(mu);
                stop = true;
            }
            cv.notify_all();
            worker.join();
        }
        if (upload) {
            ggml_backend_synchronize(upload);
        }
        for (auto & s : slots) {
            if (s.ready) ggml_backend_event_free(s.ready);
            if (s.freed) ggml_backend_event_free(s.freed);
        }
        if (buf) ggml_backend_buffer_free(buf);
        if (ctx) ggml_free(ctx);
        if (upload) ggml_backend_free(upload);
        if (n_hit + n_miss > 0) {
            LLAMA_LOG_INFO("%s: MoE prefetch: %llu tensors from the slots, %llu missed, %.1f GiB uploaded ahead\n", __func__,
                (unsigned long long) n_hit, (unsigned long long) n_miss, bytes / (1024.0*1024.0*1024.0));
        }
    }

    void run() {
        for (;;) {
            job j;
            {
                std::unique_lock<std::mutex> lock(mu);
                cv.wait(lock, [&] { return stop || !jobs.empty(); });
                if (stop) {
                    return;
                }
                j = jobs.front();
                jobs.pop_front();
            }
            slot & s = slots[j.slot];
            shape_like(s.view_upload, j.src);
            // the slot is written only after the last copy out of it has run on the main stream
            ggml_backend_event_wait(upload, s.freed);
            ggml_backend_tensor_set_async(upload, s.view_upload, j.src->data, 0, ggml_nbytes(j.src));
            ggml_backend_event_record(s.ready, upload);
            {
                std::lock_guard<std::mutex> lock(mu);
                issued = j.id;
            }
            cv.notify_all();
        }
    }

    // "blk.12.ffn_up_exps.weight" -> 12, "ffn_up_exps.weight"
    static bool parse(const char * name, int & il, std::string & role) {
        int off = 0;
        if (sscanf(name, "blk.%d.%n", &il, &off) != 1 || off == 0) {
            return false;
        }
        role = name + off;
        return true;
    }

    // the roles of one layer, in the order the graph asks for them
    void learn(const ggml_tensor * src) {
        int il;
        std::string role;
        if (roles_done || !parse(src->name, il, role)) {
            return;
        }
        if (roles_layer < 0) {
            roles_layer = il;
        }
        if (il != roles_layer) {
            roles_done = !roles.empty();
        } else if (std::find(roles.begin(), roles.end(), role) == roles.end()) {
            roles.push_back(role);
        }
    }

    // the next role in the layer, or the first one of the next layer with experts in host memory
    const ggml_tensor * predict(const ggml_tensor * src) {
        if (!roles_done) {
            return nullptr;
        }
        const auto it = next_of.find(src);
        if (it != next_of.end()) {
            return it->second;
        }
        int il;
        std::string role;
        const ggml_tensor * found = nullptr;
        if (parse(src->name, il, role)) {
            const auto ir = std::find(roles.begin(), roles.end(), role);
            if (ir != roles.end()) {
                size_t ri = (size_t) (ir - roles.begin()) + 1;
                const int n_layer = (int) model.layers.size();
                for (int k = 0; k <= n_layer && found == nullptr; k++) {
                    const int l = (il + k) % n_layer;
                    for (; ri < roles.size() && found == nullptr; ri++) {
                        const std::string name = "blk." + std::to_string(l) + "." + roles[ri];
                        const ggml_tensor * t = model.get_tensor(name.c_str());
                        if (is_host_weight(t) && ggml_nbytes(t) <= slot_size) {
                            found = t;
                        }
                    }
                    ri = 0;
                }
            }
        }
        next_of[src] = found;
        return found;
    }

    int find(const ggml_tensor * t) const {
        for (size_t i = 0; i < slots.size(); i++) {
            if (slots[i].held == t) {
                return (int) i;
            }
        }
        return -1;
    }

    void enqueue(int i, const ggml_tensor * src) {
        slot & s = slots[i];
        s.held = src;
        {
            std::lock_guard<std::mutex> lock(mu);
            s.job = ++queued;
            jobs.push_back({ i, src, s.job });
        }
        cv.notify_all();
        bytes += ggml_nbytes(src);
    }

    bool copy(ggml_backend_t backend, const ggml_tensor * src, ggml_tensor * dst) {
        if (backend != main) {
            return false;
        }
        learn(src);

        const int s = find(src);
        if (s >= 0) {
            slot & sl = slots[s];
            {
                std::unique_lock<std::mutex> lock(mu);
                cv.wait(lock, [&] { return issued >= sl.job; });
            }
            ggml_backend_event_wait(main, sl.ready);
            shape_like(sl.view_main, src);
            ggml_backend_tensor_copy_async(main, main, sl.view_main, dst);
            ggml_backend_event_record(sl.freed, main);
            sl.held = nullptr; // free for the next uploads (the worker waits for the copy above)
            n_hit++;
        } else {
            n_miss++;
        }

        if (debug && (n_hit + n_miss) % 48 == 1) {
            LLAMA_LOG_WARN("%s: MoE prefetch: %s, %llu hits, %llu misses\n", __func__, src->name,
                (unsigned long long) n_hit, (unsigned long long) n_miss);
        }

        // keep the next tensors (one fewer than the slots) uploaded or on their way
        std::vector<const ggml_tensor *> want;
        for (const ggml_tensor * x = predict(src); x != nullptr && x != src && want.size() + 1 < slots.size(); x = predict(x)) {
            if (std::find(want.begin(), want.end(), x) != want.end()) {
                break;
            }
            want.push_back(x);
        }
        for (const ggml_tensor * w : want) {
            if (find(w) >= 0) {
                continue;
            }
            // a slot that holds nothing wanted, the oldest first
            int pick = -1;
            for (size_t i = 0; i < slots.size(); i++) {
                const slot & c = slots[i];
                if (c.held != nullptr && std::find(want.begin(), want.end(), c.held) != want.end()) {
                    continue;
                }
                if (pick < 0 || c.job < slots[pick].job) {
                    pick = (int) i;
                }
            }
            if (pick < 0) {
                break;
            }
            enqueue(pick, w);
        }
        return s >= 0;
    }
};

llama_moe_prefetch::llama_moe_prefetch(std::unique_ptr<impl> pimpl) : pimpl(std::move(pimpl)) {}

llama_moe_prefetch::~llama_moe_prefetch() = default;

bool llama_moe_prefetch::copy(ggml_backend_t backend, const ggml_tensor * src, ggml_tensor * dst) {
    return pimpl->copy(backend, src, dst);
}

std::unique_ptr<llama_moe_prefetch> llama_moe_prefetch::create(const llama_model & model, ggml_backend_t backend) {
    ggml_backend_dev_t dev = ggml_backend_get_device(backend);
    if (dev == nullptr || ggml_backend_dev_type(dev) != GGML_BACKEND_DEVICE_TYPE_GPU) {
        LLAMA_LOG_WARN("%s: MoE prefetch needs a discrete GPU, off\n", __func__);
        return nullptr;
    }
    // the worker thread does not select the device: only one GPU
    int n_gpu = 0;
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        if (ggml_backend_dev_type(ggml_backend_dev_get(i)) == GGML_BACKEND_DEVICE_TYPE_GPU) {
            n_gpu++;
        }
    }
    if (n_gpu != 1) {
        LLAMA_LOG_WARN("%s: MoE prefetch needs exactly one GPU, off\n", __func__);
        return nullptr;
    }

    auto p = std::make_unique<impl>(model);
    for (const auto & [name, t] : model.tensors_by_name) {
        if (name.find("_exps") != std::string::npos && is_host_weight(t)) {
            p->slot_size = std::max(p->slot_size, ggml_nbytes(t));
        }
    }
    if (p->slot_size == 0) {
        LLAMA_LOG_WARN("%s: MoE prefetch: no experts in host memory, off\n", __func__);
        return nullptr;
    }
    p->slot_size = GGML_PAD(p->slot_size, 256);

    // LLAMA_MOE_PREFETCH_SLOTS: device slots, one more than the tensors uploaded ahead (2..8, 4:
    // measured on an RTX 4080 Super, 2 slots give x1.21, 3 x1.46, 4 x1.53, 6 the same as 4)
    int n_slots = 4;
    if (const char * v = getenv("LLAMA_MOE_PREFETCH_SLOTS")) {
        n_slots = std::min(8, std::max(2, atoi(v)));
    }

    // only what fits in the free memory of the card, with a margin: on Windows an allocation past it
    // succeeds and lands in shared system memory (Sysmem Fallback), slower than no prefetch at all
    size_t mem_free = 0, mem_total = 0;
    ggml_backend_dev_memory(dev, &mem_free, &mem_total);
    const size_t margin = 512u*1024*1024;
    const int fit = mem_free > margin ? (int) std::min<size_t>(8, (mem_free - margin) / p->slot_size) : 0;
    if (fit < n_slots) {
        LLAMA_LOG_WARN("%s: MoE prefetch: %.0f MiB free on the card, %d slots instead of %d\n", __func__,
            mem_free / (1024.0*1024.0), std::max(fit, 0), n_slots);
        n_slots = fit;
    }
    if (n_slots < 2) {
        LLAMA_LOG_WARN("%s: MoE prefetch: no room on the card, off\n", __func__);
        return nullptr;
    }

    p->main   = backend;
    p->upload = ggml_backend_dev_init(dev, nullptr);
    if (p->upload == nullptr) {
        LLAMA_LOG_WARN("%s: MoE prefetch: no second backend, off\n", __func__);
        return nullptr;
    }
    p->slots.resize(n_slots);
    for (auto & s : p->slots) {
        s.ready = ggml_backend_event_new(dev);
        s.freed = ggml_backend_event_new(dev);
        if (s.ready == nullptr || s.freed == nullptr) {
            LLAMA_LOG_WARN("%s: MoE prefetch needs events, off\n", __func__);
            return nullptr;
        }
    }
    p->buf = ggml_backend_buft_alloc_buffer(ggml_backend_dev_buffer_type(dev), n_slots*p->slot_size);
    if (p->buf == nullptr) {
        LLAMA_LOG_WARN("%s: MoE prefetch: no room for %d slots of %.1f MiB, off\n", __func__, n_slots, p->slot_size / (1024.0*1024.0));
        return nullptr;
    }
    ggml_init_params params = { 2*n_slots*ggml_tensor_overhead(), nullptr, true };
    p->ctx = ggml_init(params);
    uint8_t * base = (uint8_t *) ggml_backend_buffer_get_base(p->buf);
    for (int i = 0; i < n_slots; i++) {
        for (ggml_tensor ** v : { &p->slots[i].view_main, &p->slots[i].view_upload }) {
            *v = ggml_new_tensor_1d(p->ctx, GGML_TYPE_I8, (int64_t) p->slot_size);
            (*v)->buffer = p->buf;
            (*v)->data   = base + i*p->slot_size;
        }
    }
    p->worker = std::thread([raw = p.get()] { raw->run(); });

    LLAMA_LOG_INFO("%s: MoE prefetch on: %d slots of %.1f MiB on %s\n", __func__, n_slots,
        p->slot_size / (1024.0*1024.0), ggml_backend_dev_name(dev));
    return std::unique_ptr<llama_moe_prefetch>(new llama_moe_prefetch(std::move(p)));
}
