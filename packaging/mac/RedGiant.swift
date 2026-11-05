// RedGiant for macOS (2026-11-05): what RedGiant.exe is on Windows. A menu bar app that starts the
// server it carries (Node and the server inside the app), waits until it answers, opens the browser
// already signed in, and stops it the proper way when it quits. Everything RedGiant keeps lives in
// ~/Library/Application Support/RedGiant (data/ with the database, engine/ with the local models),
// its logs in ~/Library/Logs/RedGiant.
//
//   RedGiant.app/Contents/MacOS/RedGiant          this program
//   RedGiant.app/Contents/Resources/node/node     Node
//   RedGiant.app/Contents/Resources/server        the server, with its production modules
//   RedGiant.app/Contents/Resources/web           the web page
//
// Arguments (for the CI and for whoever helps): --background (no browser), --quit (asks a running
// RedGiant to stop, and waits).

import Cocoa
import ServiceManagement

let fm = FileManager.default
let home = fm.homeDirectoryForCurrentUser
let support = home.appendingPathComponent("Library/Application Support/RedGiant")
let dataDir = support.appendingPathComponent("data")
let logsDir = home.appendingPathComponent("Library/Logs/RedGiant")
let resources = Bundle.main.resourceURL!
let quitNote = Notification.Name("com.redgiant.quit")

func say(_ key: String) -> String {
  let it = Locale.preferredLanguages.first?.hasPrefix("it") ?? false
  let texts: [String: (String, String)] = [
    "open": ("Apri RedGiant", "Open RedGiant"),
    "login": ("Avvia al login", "Start at login"),
    "uninstall": ("Disinstalla RedGiant…", "Uninstall RedGiant…"),
    "quit": ("Esci da RedGiant", "Quit RedGiant"),
    "starting": ("RedGiant si sta avviando…", "RedGiant is starting…"),
    "ready": ("RedGiant è pronto", "RedGiant is ready"),
    "failed": ("RedGiant non è partito", "RedGiant did not start"),
    "failedText": (
      "Il server non ha risposto. I dettagli sono in ~/Library/Logs/RedGiant/server.log.",
      "The server did not answer. The details are in ~/Library/Logs/RedGiant/server.log."
    ),
    "uninstallTitle": ("Disinstallare RedGiant?", "Uninstall RedGiant?"),
    "uninstallText": (
      "Il programma va nel Cestino. Conversazioni, progetti, impostazioni e modelli locali stanno in ~/Library/Application Support/RedGiant: vuoi tenerli?",
      "The program goes to the Trash. Conversations, projects, settings and local models are in ~/Library/Application Support/RedGiant: keep them?"
    ),
    "keep": ("Disinstalla e tieni i dati", "Uninstall, keep the data"),
    "delete": ("Disinstalla e cancella tutto", "Uninstall and delete everything"),
    "cancel": ("Annulla", "Cancel"),
  ]
  let t = texts[key] ?? (key, key)
  return it ? t.0 : t.1
}

/** The server's token: made the first time, kept in the data folder, readable by this user only. */
func token() -> String {
  let file = dataDir.appendingPathComponent("token.txt")
  if let t = try? String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
    t.count >= 32
  {
    return t
  }
  var bytes = [UInt8](repeating: 0, count: 24)
  _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
  let t = bytes.map { String(format: "%02x", $0) }.joined()
  try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
  fm.createFile(atPath: file.path, contents: t.data(using: .utf8), attributes: [.posixPermissions: 0o600])
  return t
}

/** 7600 when free; otherwise the next free port. */
func freePort() -> Int {
  for port in 7600..<7700 {
    let s = socket(AF_INET, SOCK_STREAM, 0)
    if s < 0 { continue }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port).bigEndian)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let ok = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
      }
    }
    close(s)
    if ok { return port }
  }
  return 7600
}

func healthy(_ port: Int) -> Bool {
  guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return false }
  var req = URLRequest(url: url)
  req.timeoutInterval = 2
  let done = DispatchSemaphore(value: 0)
  var ok = false
  URLSession.shared.dataTask(with: req) { _, res, _ in
    ok = (res as? HTTPURLResponse)?.statusCode == 200
    done.signal()
  }.resume()
  _ = done.wait(timeout: .now() + 3)
  return ok
}

final class App: NSObject, NSApplicationDelegate {
  var item: NSStatusItem!
  var server: Process?
  var stdin: Pipe?
  var port = 7600
  var url: URL?
  var quitting = false
  let background = CommandLine.arguments.contains("--background")

  func applicationDidFinishLaunching(_ n: Notification) {
    // Another RedGiant asks this one to stop (`--quit`).
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(quit), name: quitNote, object: nil)
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let icon = NSImage(contentsOf: resources.appendingPathComponent("menubar.png")) {
      icon.size = NSSize(width: 18, height: 18)
      item.button?.image = icon
    } else {
      item.button?.title = "RG"
    }
    item.button?.toolTip = say("starting")
    let menu = NSMenu()
    menu.addItem(withTitle: say("open"), action: #selector(openPage), keyEquivalent: "o")
    let login = menu.addItem(withTitle: say("login"), action: #selector(toggleLogin), keyEquivalent: "")
    login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    menu.addItem(.separator())
    menu.addItem(withTitle: say("uninstall"), action: #selector(uninstall), keyEquivalent: "")
    menu.addItem(.separator())
    menu.addItem(withTitle: say("quit"), action: #selector(quit), keyEquivalent: "q")
    item.menu = menu
    start()
  }

  /** Opening RedGiant again (Dock, Spotlight, Applications): the page. */
  func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows: Bool) -> Bool {
    openPage()
    return false
  }

  func start() {
    try? fm.createDirectory(at: logsDir, withIntermediateDirectories: true)
    try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
    port = freePort()
    let t = token()
    let p = Process()
    p.executableURL = resources.appendingPathComponent("node/node")
    p.arguments = [resources.appendingPathComponent("server/dist/main.js").path]
    p.currentDirectoryURL = resources.appendingPathComponent("server")
    var env = ProcessInfo.processInfo.environment
    env["REDGIANT_TOKEN"] = t
    env["DATABASE_URL"] = "embedded"
    env["REDGIANT_DATA_DIR"] = dataDir.path
    env["REDGIANT_PORT"] = String(port)
    env["REDGIANT_HOST"] = "127.0.0.1"
    env["REDGIANT_WEB_DIR"] = resources.appendingPathComponent("web").path
    env["REDGIANT_WIN_ENGINE_DIR"] = support.appendingPathComponent("engine").path
    // The server stops when this program goes, even if it is killed.
    env["REDGIANT_STOP_ON_STDIN_END"] = "1"
    p.environment = env
    let log = logsDir.appendingPathComponent("server.log")
    if fm.fileExists(atPath: log.path),
      let size = (try? fm.attributesOfItem(atPath: log.path))?[.size] as? Int, size > 20_000_000
    {
      try? fm.removeItem(at: logsDir.appendingPathComponent("server.old.log"))
      try? fm.moveItem(at: log, to: logsDir.appendingPathComponent("server.old.log"))
    }
    if !fm.fileExists(atPath: log.path) { fm.createFile(atPath: log.path, contents: nil) }
    let out = try? FileHandle(forWritingTo: log)
    out?.seekToEndOfFile()
    p.standardOutput = out
    p.standardError = out
    let input = Pipe()
    p.standardInput = input
    stdin = input
    p.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, !self.quitting else { return }
        self.item.button?.toolTip = say("failed")
      }
    }
    do { try p.run() } catch {
      fail()
      return
    }
    server = p
    url = URL(string: "http://localhost:\(port)/#token=\(t)")
    DispatchQueue.global().async { [weak self] in
      guard let self else { return }
      for _ in 0..<180 {
        if !p.isRunning { break }
        if healthy(self.port) {
          DispatchQueue.main.async {
            self.item.button?.toolTip = say("ready")
            if !self.background { self.openPage() }
          }
          return
        }
        Thread.sleep(forTimeInterval: 1)
      }
      DispatchQueue.main.async { self.fail() }
    }
  }

  func fail() {
    item.button?.toolTip = say("failed")
    if background { return }
    let a = NSAlert()
    a.messageText = say("failed")
    a.informativeText = say("failedText")
    NSApp.activate(ignoringOtherApps: true)
    a.runModal()
  }

  @objc func openPage() {
    if let url { NSWorkspace.shared.open(url) }
  }

  @objc func toggleLogin(_ sender: NSMenuItem) {
    do {
      if SMAppService.mainApp.status == .enabled {
        try SMAppService.mainApp.unregister()
      } else {
        try SMAppService.mainApp.register()
      }
    } catch {}
    sender.state = SMAppService.mainApp.status == .enabled ? .on : .off
  }

  /** Stops the server: its stdin closes, it shuts down by itself (database included). */
  func stopServer() {
    guard let p = server else { return }
    try? stdin?.fileHandleForWriting.close()
    p.interrupt()
    let deadline = Date().addingTimeInterval(20)
    while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
    if p.isRunning { p.terminate() }
    server = nil
  }

  @objc func quit() {
    quitting = true
    stopServer()
    NSApp.terminate(nil)
  }

  func applicationWillTerminate(_ n: Notification) {
    quitting = true
    stopServer()
  }

  @objc func uninstall() {
    let a = NSAlert()
    a.messageText = say("uninstallTitle")
    a.informativeText = say("uninstallText")
    a.addButton(withTitle: say("keep"))
    a.addButton(withTitle: say("delete"))
    a.addButton(withTitle: say("cancel"))
    NSApp.activate(ignoringOtherApps: true)
    let answer = a.runModal()
    if answer == .alertThirdButtonReturn { return }
    quitting = true
    stopServer()
    try? SMAppService.mainApp.unregister()
    if answer == .alertSecondButtonReturn {
      try? fm.removeItem(at: support)
      try? fm.removeItem(at: logsDir)
    } else {
      // The data stays; the engine's programs come down again if RedGiant comes back.
      try? fm.removeItem(at: support.appendingPathComponent("engine/bin"))
    }
    NSWorkspace.shared.recycle([Bundle.main.bundleURL]) { _, _ in
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }
}

// `--quit`: asks the running RedGiant to stop, and waits until its server is gone.
if CommandLine.arguments.contains("--quit") {
  DistributedNotificationCenter.default().postNotificationName(
    quitNote, object: nil, userInfo: nil, deliverImmediately: true)
  let me = ProcessInfo.processInfo.processIdentifier
  let deadline = Date().addingTimeInterval(30)
  while Date() < deadline {
    let others = NSRunningApplication.runningApplications(
      withBundleIdentifier: Bundle.main.bundleIdentifier ?? "com.redgiant.app"
    ).filter { $0.processIdentifier != me }
    if others.isEmpty { exit(0) }
    Thread.sleep(forTimeInterval: 0.3)
  }
  exit(1)
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
