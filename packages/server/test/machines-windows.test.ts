// A Windows machine (p3.7.2: Rig, OpenSSH for Windows with PowerShell 7 as its shell): its working
// folder is a drive path (E:\coding\XAMPP\htdocs or E:/coding/XAMPP/htdocs), commands start there
// in a way PowerShell and cmd both take (pushd, double quotes, no characters either shell would
// expand), and SFTP reaches it as OpenSSH for Windows names it (/E:/coding/…).
import { MachineBody } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import { folderOf, homeOf, remoteLine } from "../src/machines.js";
import { remoteTarget } from "../src/ssh-tools.js";

const body = (folder: string) =>
  MachineBody.safeParse({ name: "rig", host: "192.168.1.53", user: "Pixel", folder });

describe("a Windows machine's working folder", () => {
  it.each([
    ["E:/coding/XAMPP/htdocs", true],
    ["E:\\coding\\XAMPP\\htdocs", true],
    ["c:\\Users\\Pixel", true],
    ["E:\\", true],
    ["/srv/app", true],
    ["~/app", true],
    ["coding/XAMPP", false],
    ["E:", false],
    ["E:coding", false],
    ['E:\\a"b', false],
    ["E:\\100%", false],
    ["E:\\$env:x", false],
    ["E:\\a`b", false],
    ["\\\\server\\share", false],
  ])("%s", (folder, ok) => {
    expect(body(folder).success).toBe(ok);
  });

  it("is written with backslashes, without the last one; the home is C:\\Users\\<user>", () => {
    expect(folderOf({ folder: "E:/coding/XAMPP/htdocs/", user: "Pixel" })).toBe(
      "E:\\coding\\XAMPP\\htdocs",
    );
    expect(folderOf({ folder: "E:\\", user: "Pixel" })).toBe("E:\\");
    expect(folderOf({ folder: "~/app/", user: "deploy" })).toBe("/home/deploy/app");
    expect(homeOf("Pixel", true)).toBe("C:\\Users\\Pixel");
    expect(homeOf("deploy")).toBe("/home/deploy");
  });

  it("commands start there with pushd (PowerShell 7 and cmd), a POSIX shell with cd", () => {
    expect(remoteLine("git status", "E:/coding/XAMPP/htdocs")).toBe(
      'pushd "E:\\coding\\XAMPP\\htdocs" && git status',
    );
    expect(remoteLine("ls", "/srv/my app")).toBe("cd '/srv/my app' && ls");
    expect(remoteLine("ls", "~/app")).toBe("cd \"$HOME\"/'app' && ls");
    expect(remoteLine("dir", undefined)).toBe("dir");
    expect(() => remoteLine("dir", "E:\\100%")).toThrow(/cannot be used/);
  });

  it("SFTP paths as OpenSSH for Windows names them", () => {
    const home = "/C:/Users/Pixel";
    const m = { folder: "E:\\coding\\XAMPP\\htdocs" };
    expect(remoteTarget(home, m, undefined)).toBe("/E:/coding/XAMPP/htdocs");
    expect(remoteTarget(home, m, "sito\\index.php")).toBe("/E:/coding/XAMPP/htdocs/sito/index.php");
    expect(remoteTarget(home, m, "D:\\backup")).toBe("/D:/backup");
    expect(remoteTarget(home, m, "~/Desktop")).toBe("/C:/Users/Pixel/Desktop");
    expect(remoteTarget(home, {}, "x.txt")).toBe("/C:/Users/Pixel/x.txt");
    expect(remoteTarget("/home/deploy", { folder: "/srv/app" }, "a/b")).toBe("/srv/app/a/b");
  });
});
