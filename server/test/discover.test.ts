import { test } from "node:test";
import assert from "node:assert/strict";
import { aRecords, mdnsQuery, parseArp } from "../discover.ts";

test("mDNS query: one PTR question per service, labels length-prefixed", () => {
  const q = mdnsQuery(["_lxi._tcp.local"]);
  assert.deepEqual([...q.subarray(0, 12)], [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  assert.equal(q[12], 4);
  assert.equal(String.fromCharCode(...q.subarray(13, 17)), "_lxi");
  assert.deepEqual([...q.subarray(q.length - 5)], [0, 0, 12, 0, 1]);
});

test("A records are read from a response with name compression", () => {
  // header: 0 questions, 1 answer (PTR), 0 authority, 1 additional (A)
  const name = [4, 95, 108, 120, 105, 4, 95, 116, 99, 112, 5, 108, 111, 99, 97, 108, 0]; // _lxi._tcp.local
  const ptr = [...name, 0, 12, 0, 1, 0, 0, 0, 120, 0, 2, 0xc0, 12];
  const a = [0xc0, 12, 0, 1, 0x80, 1, 0, 0, 0, 120, 0, 4, 169, 254, 17, 3];
  const msg = Uint8Array.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 1, ...ptr, ...a]);
  assert.deepEqual(aRecords(msg), ["169.254.17.3"]);
  assert.deepEqual(aRecords(new Uint8Array(3)), []);
});

test("ARP tables from macOS and Windows; incomplete, broadcast and multicast entries skipped", () => {
  const mac = [
    "? (192.168.1.1) at 0:11:22:33:44:55 on en0 ifscope [ethernet]",
    "? (169.254.17.3) at 0:19:af:1:2:3 on en7 [ethernet]",
    "? (192.168.1.77) at (incomplete) on en0 ifscope [ethernet]",
    "? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]",
    "? (192.168.1.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]",
  ].join("\n");
  assert.deepEqual(parseArp(mac), ["192.168.1.1", "169.254.17.3"]);
  const win = "Interface: 169.254.9.1 --- 0x7\r\n  Internet Address      Physical Address      Type\r\n  169.254.17.3          00-19-af-01-02-03     dynamic\r\n";
  assert.deepEqual(parseArp(win), ["169.254.9.1", "169.254.17.3"]);
});

test("a LAN address this computer has no network for is explained, with the address to give the adapter", async () => {
  const { networkHint } = await import("../discover.ts");
  const nic = (address: string, netmask: string) => ({ address, netmask, family: "IPv4" as const, internal: false, mac: "00:00:00:00:00:00", cidr: null });
  // This Mac on 2026-10-17: Wi-Fi on an iPhone hotspot, the USB-C LAN adapter self-assigned.
  const mac = { en0: [nic("172.20.10.3", "255.255.255.240")], en9: [nic("169.254.233.220", "255.255.0.0")] };
  const h = networkHint("10.11.13.220", mac)!;
  assert.match(h, /no address in 10\.11\.13\.x/);
  assert.match(h, /en9 \(169\.254\.233\.220\) gave itself a 169\.254 address/);
  assert.match(h, /IP address 10\.11\.13\.10, subnet mask 255\.255\.255\.0/);
  // Already in the network: not this problem.
  assert.equal(networkHint("172.20.10.5", mac), null);
  assert.equal(networkHint("10.11.13.220", { ...mac, en9: [nic("10.11.13.10", "255.255.255.0")] }), null);
  // Both self-assigned: may go out of Wi-Fi.
  assert.match(networkHint("169.254.7.7", mac)!, /route out of Wi-Fi/);
  assert.equal(networkHint("scope.local", mac), null);
});
