#!/usr/bin/env python3
"""RedGiant OS (G39.2): the packages of the virtual machine formats, Python's own modules only.

  vm.py zip <file> <out.zip>                     one file in a zip (Windows opens it by itself)
  vm.py ova --vmdk <disk.vmdk> --name <name> --capacity <bytes> --out <out.ova> [--cpus 2] [--memory 4096]
  vm.py check-ova <file.ova>                     what CI checks: order, manifest, descriptor, sizes

The OVA is an OVF 1.0 descriptor, its SHA-256 manifest and one streamOptimized VMDK, in that order
in a ustar archive, as VMware and VirtualBox both read it. The hardware is what both have: an LSI
Logic SCSI controller and an Intel E1000 network card (Debian's kernel drives both from its
initramfs); VMware's firmware key asks for EFI with Secure Boot (Debian's shim is signed by the
Microsoft UEFI CA VMware trusts), VirtualBox ignores it and starts the same disk through its BIOS
(the image boots either way). Every time stamp is SOURCE_DATE_EPOCH: the same inputs give the same
files.
"""

import hashlib
import os
import sys
import tarfile
import time
import xml.etree.ElementTree as ET
import zipfile

OVF = "http://schemas.dmtf.org/ovf/envelope/1"
RASD = "http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ResourceAllocationSettingData"
VSSD = "http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_VirtualSystemSettingData"
VMW = "http://www.vmware.com/schema/ovf"
STREAM = "http://www.vmware.com/interfaces/specifications/vmdk.html#streamOptimized"


def epoch():
    return int(os.environ.get("SOURCE_DATE_EPOCH") or time.time())


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def item(**fields):
    """One hardware item; the CIM schema wants its elements in alphabetical order."""
    body = "".join(f"\n        <rasd:{k}>{esc(str(v))}</rasd:{k}>" for k, v in sorted(fields.items()))
    return f"      <Item>{body}\n      </Item>\n"


def descriptor(name, vmdk_name, vmdk_size, capacity, cpus, memory):
    gib = capacity // (1 << 30)
    if gib * (1 << 30) != capacity:
        raise SystemExit("capacity: a whole number of GiB")
    hardware = (
        item(InstanceID=1, ResourceType=3, VirtualQuantity=cpus, AllocationUnits="hertz * 10^6",
             ElementName=f"{cpus} virtual CPUs", Description="Number of virtual CPUs")
        + item(InstanceID=2, ResourceType=4, VirtualQuantity=memory, AllocationUnits="byte * 2^20",
               ElementName=f"{memory} MB of memory", Description="Memory size")
        + item(InstanceID=3, ResourceType=6, ResourceSubType="lsilogic", Address=0,
               ElementName="SCSI controller 0", Description="SCSI controller")
        + item(InstanceID=4, ResourceType=17, Parent=3, AddressOnParent=0, HostResource="ovf:/disk/vmdisk1",
               ElementName="Hard disk 1", Description="The system disk")
        + item(InstanceID=5, ResourceType=10, ResourceSubType="E1000", Connection="bridged",
               AutomaticAllocation="true", AddressOnParent=7, ElementName="Ethernet adapter 1",
               Description="E1000 network card")
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!-- RedGiant OS (G39.2): packaging/os/formats/vm.py -->
<Envelope ovf:version="1.0" xml:lang="en-US" xmlns="{OVF}" xmlns:ovf="{OVF}" xmlns:rasd="{RASD}" xmlns:vssd="{VSSD}" xmlns:vmw="{VMW}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <References>
    <File ovf:id="file1" ovf:href="{esc(vmdk_name)}" ovf:size="{vmdk_size}"/>
  </References>
  <DiskSection>
    <Info>The virtual disk</Info>
    <Disk ovf:capacity="{gib}" ovf:capacityAllocationUnits="byte * 2^30" ovf:diskId="vmdisk1" ovf:fileRef="file1" ovf:format="{STREAM}"/>
  </DiskSection>
  <NetworkSection>
    <Info>The network</Info>
    <Network ovf:name="bridged">
      <Description>The network RedGiant OS is reached on (bridged to the host's)</Description>
    </Network>
  </NetworkSection>
  <VirtualSystem ovf:id="{esc(name)}">
    <Info>RedGiant OS, a Debian 13 system that runs RedGiant</Info>
    <Name>{esc(name)}</Name>
    <AnnotationSection>
      <Info>About this machine</Info>
      <Annotation>RedGiant OS. Start it and open the address its screen shows (http://redgiant.local:7600). https://github.com/Frostmoore/redgiant2/blob/main/docs/INSTALL-OS.md</Annotation>
    </AnnotationSection>
    <OperatingSystemSection ovf:id="96" vmw:osType="debian10_64Guest">
      <Info>The guest operating system</Info>
      <Description>Debian GNU/Linux 13 (64-bit)</Description>
    </OperatingSystemSection>
    <VirtualHardwareSection>
      <Info>The virtual hardware</Info>
      <System>
        <vssd:ElementName>Virtual Hardware Family</vssd:ElementName>
        <vssd:InstanceID>0</vssd:InstanceID>
        <vssd:VirtualSystemIdentifier>{esc(name)}</vssd:VirtualSystemIdentifier>
        <vssd:VirtualSystemType>vmx-14</vssd:VirtualSystemType>
      </System>
{hardware}      <vmw:Config ovf:required="false" vmw:key="firmware" vmw:value="efi"/>
      <vmw:Config ovf:required="false" vmw:key="uefi.secureBoot.enabled" vmw:value="true"/>
    </VirtualHardwareSection>
  </VirtualSystem>
</Envelope>
"""


def add(tar, path, arcname, mtime):
    info = tar.gettarinfo(path, arcname)
    info.mtime, info.uid, info.gid, info.uname, info.gname, info.mode = mtime, 0, 0, "", "", 0o644
    with open(path, "rb") as f:
        tar.addfile(info, f)


def make_ova(vmdk, name, capacity, out, cpus=2, memory=4096):
    work = os.path.dirname(os.path.abspath(out))
    vmdk_name = f"{name}-disk1.vmdk"
    ovf_path = os.path.join(work, f"{name}.ovf")
    mf_path = os.path.join(work, f"{name}.mf")
    with open(ovf_path, "w", encoding="utf-8") as f:
        f.write(descriptor(name, vmdk_name, os.path.getsize(vmdk), capacity, cpus, memory))
    with open(mf_path, "w", encoding="utf-8") as f:
        f.write(f"SHA256({name}.ovf)= {sha256(ovf_path)}\nSHA256({vmdk_name})= {sha256(vmdk)}\n")
    mtime = epoch()
    with tarfile.open(out, "w", format=tarfile.USTAR_FORMAT) as tar:
        add(tar, ovf_path, f"{name}.ovf", mtime)
        add(tar, mf_path, f"{name}.mf", mtime)
        add(tar, vmdk, vmdk_name, mtime)
    os.remove(ovf_path)
    os.remove(mf_path)


def check_ova(path):
    """Raises on anything VMware or VirtualBox would refuse; prints what it saw."""
    with tarfile.open(path, "r:") as tar:
        members = tar.getmembers()
        names = [m.name for m in members]
        if len(names) != 3 or not names[0].endswith(".ovf") or not names[1].endswith(".mf"):
            raise SystemExit(f"order: the descriptor, the manifest, the disk ({names})")
        if any("/" in n or n.startswith(".") for n in names):
            raise SystemExit(f"names: plain file names only ({names})")
        data = {m.name: tar.extractfile(m).read() for m in members[:2]}
        digests = {}
        for m in members:
            h = hashlib.sha256()
            f = tar.extractfile(m)
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
            digests[m.name] = h.hexdigest()
        sizes = {m.name: m.size for m in members}
    root = ET.fromstring(data[names[0]])
    ns = {"ovf": OVF, "rasd": RASD, "vssd": VSSD, "vmw": VMW}
    if root.tag != f"{{{OVF}}}Envelope" or root.get(f"{{{OVF}}}version") != "1.0":
        raise SystemExit("descriptor: not an OVF 1.0 envelope")
    files = root.findall("ovf:References/ovf:File", ns)
    if [f.get(f"{{{OVF}}}href") for f in files] != [names[2]]:
        raise SystemExit("descriptor: its file is not the archive's disk")
    if int(files[0].get(f"{{{OVF}}}size")) != sizes[names[2]]:
        raise SystemExit("descriptor: the disk's size differs")
    disk = root.find("ovf:DiskSection/ovf:Disk", ns)
    if disk is None or disk.get(f"{{{OVF}}}format") != STREAM or disk.get(f"{{{OVF}}}fileRef") != "file1":
        raise SystemExit("descriptor: the disk is not a streamOptimized VMDK")
    hw = root.find("ovf:VirtualSystem/ovf:VirtualHardwareSection", ns)
    kinds = {}
    for it in hw.findall("ovf:Item", ns):
        tags = [c.tag.split("}")[1] for c in it]
        if tags != sorted(tags):
            raise SystemExit(f"descriptor: an item's elements are not in order ({tags})")
        kinds[it.find("rasd:ResourceType", ns).text] = it
    for kind, what in (("3", "processors"), ("4", "memory"), ("6", "SCSI controller"), ("17", "disk"), ("10", "network")):
        if kind not in kinds:
            raise SystemExit(f"descriptor: no {what}")
    if kinds["17"].find("rasd:HostResource", ns).text != "ovf:/disk/vmdisk1":
        raise SystemExit("descriptor: the disk item does not use the disk")
    if kinds["10"].find("rasd:Connection", ns).text not in {
        n.get(f"{{{OVF}}}name") for n in root.findall("ovf:NetworkSection/ovf:Network", ns)
    }:
        raise SystemExit("descriptor: the network card's network is not declared")
    firmware = [c.get(f"{{{VMW}}}value") for c in hw.findall("vmw:Config", ns) if c.get(f"{{{VMW}}}key") == "firmware"]
    if firmware != ["efi"]:
        raise SystemExit("descriptor: no EFI firmware for VMware")
    manifest = {}
    for line in data[names[1]].decode().splitlines():
        algo, _, rest = line.partition("(")
        name, _, digest = rest.partition(")= ")
        if algo != "SHA256":
            raise SystemExit(f"manifest: {algo} instead of SHA256")
        manifest[name] = digest.strip()
    if manifest != {names[0]: digests[names[0]], names[2]: digests[names[2]]}:
        raise SystemExit("manifest: the digests differ")
    with tarfile.open(path, "r:") as tar:
        head = tar.extractfile(names[2]).read(512)
    if head[:4] != b"KDMV":
        raise SystemExit("disk: not a VMDK")
    print(f"ova ok: {names}, disk {sizes[names[2]]} bytes, capacity {disk.get(f'{{{OVF}}}capacity')} GiB")


def zip_one(src, out):
    info = zipfile.ZipInfo(os.path.basename(src), time.gmtime(max(epoch(), 315532800))[:6])
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    with zipfile.ZipFile(out, "w", allowZip64=True) as z, open(src, "rb") as f:
        with z.open(info, "w", force_zip64=True) as dst:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                dst.write(chunk)


def main(argv):
    if len(argv) == 3 and argv[0] == "zip":
        return zip_one(argv[1], argv[2])
    if len(argv) == 2 and argv[0] == "check-ova":
        return check_ova(argv[1])
    if argv and argv[0] == "ova":
        opts = dict(zip(argv[1::2], argv[2::2]))
        try:
            return make_ova(opts["--vmdk"], opts["--name"], int(opts["--capacity"]), opts["--out"],
                            int(opts.get("--cpus", 2)), int(opts.get("--memory", 4096)))
        except KeyError as e:
            raise SystemExit(f"ova: {e.args[0]} is needed") from None
    raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
