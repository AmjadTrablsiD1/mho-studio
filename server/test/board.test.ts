// The STM32 board link and service against the simulated board: speed
// probing, the firmware version gate, lost and late replies, a missing
// Si5351, and the board being held by a sweep. No real serial port is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.MHO_STUDIO_HOME = mkdtempSync(join(tmpdir(), "mho-studio-test-"));
process.env.MHO_STUDIO_NO_USB = "1";
process.env.MHO_STUDIO_NO_SERIAL = "1"; // never open the real board on this computer's serial ports

const { BoardLink, BoardService, listBoardPorts, openError } = await import("../board.ts");
const { SimBoard, planDacSine, planSi5351 } = await import("../../sim/board.ts");
const { Cmd, packAck } = await import("../../core/src/board/protocol.ts");
const { C } = await import("../../core/src/constants.ts");

const sim = (o: ConstructorParameters<typeof SimBoard>[0] = {}) => {
  const s = new BoardService();
  s.simFactory = () => new SimBoard({ wire: false, ...o });
  return s;
};

test("connects to the simulated board: speed, firmware version, the three outputs", async () => {
  const b = sim();
  const st = await b.connect("sim");
  assert.equal(st.state, "connected");
  assert.equal(st.baud, 115200);
  assert.equal(st.version?.protocol, C.board.sim.protocol);
  assert.equal(st.clk.length, 3);
  assert.equal(st.clk[0].hz, 10e6);
  await b.disconnect();
  assert.equal(b.state.state, "idle");
});

test("a board left at another speed is found there", async () => {
  const b = sim({ baud: 460800 });
  const st = await b.connect("sim");
  assert.equal(st.baud, 460800);
  await b.disconnect();
});

test("firmware too old for the Si5351 commands is refused with what to do", async () => {
  const b = sim({ protocol: 14 });
  await assert.rejects(b.connect("sim"), /protocol v14.*v16 or newer.*flash/);
  assert.equal(b.state.state, "error");
});

test("set returns what the Si5351 makes, not what was asked", async () => {
  const b = sim();
  await b.connect("sim");
  const want = 12345.678;
  const c = await b.set(1, want, true);
  assert.equal(c.hz, planSi5351(C.board.si5351.xtal_hz, want)!.hz);
  assert.equal(c.on, true);
  assert.equal(b.state.clk[1].hz, c.hz);
  assert.ok(b.state.log.some((l) => /CLK1 on/.test(l)), "the firmware's log line was kept, not mistaken for a reply");
  await assert.rejects(b.set(1, 1000, true), /cannot make 1(\.00)? kHz.*2\.5 kHz/);
  await b.disconnect();
});

test("the DAC sine reports the frequency the timer makes, often hertz from the request; stop puts it idle", async () => {
  const b = sim();
  await b.connect("sim");
  assert.equal(b.state.dac?.running, false);
  const r = await b.dacSine(7000, 0.5, 1.65);
  assert.equal(r.hz, planDacSine(7000).hz);
  assert.notEqual(r.hz, 7000);
  assert.ok(Math.abs(r.hz / 7000 - 1) < 0.002, `${r.hz}`);
  assert.equal(b.state.dac?.source, 2);
  assert.deepEqual(b.sim!.dacLevels, { ampMv: 500, offsetMv: 1650, hz: r.hz });
  await b.dacStop();
  assert.equal(b.state.dac?.running, false);
  await b.disconnect();
});

test("a DAC held by a control-loop run or the board's own sweep is refused in words", async () => {
  const b = sim({ dacBusy: true });
  await b.connect("sim");
  await assert.rejects(b.dacSine(1000, 0.5, 1.65), /DAC is in use — a control-loop run \(Loop Bench\) or the board's own sweep/);
  await b.disconnect();
});

test("no Si5351 on the bus: the error says where it should be", async () => {
  const b = sim({ si5351: false });
  await b.connect("sim");
  await assert.rejects(b.set(0, 1e6, true), /no Si5351 answered at 0x60.*P1 pins 12/);
  assert.equal(b.state.si5351?.present, false);
  const d = await b.detect();
  assert.equal(d.si5351?.present, false);
  await b.disconnect();
});

test("a lost reply times out, and the next command still gets its own answer", async () => {
  const b = sim({ drop: 0 });
  await b.connect("sim");
  b.sim!.drop = 1;
  await assert.rejects(b.get(0), /did not answer/);
  assert.equal((await b.get(0)).ch, 0);
  await b.disconnect();
});

test("a late reply to an abandoned command is not taken as the next one's", async () => {
  const sent: Uint8Array[] = [];
  const port = { write: async (x: Uint8Array) => void sent.push(x), setBaud: async () => {}, close: async () => {}, onData: (_: Uint8Array) => {}, onClose: (_: string) => {} };
  const link = new BoardLink(port);
  const first = link.command(Cmd.Ping, undefined, 50);
  await assert.rejects(first, /did not answer/);
  const second = link.command(Cmd.GetVersion, undefined, 500);
  await new Promise((r) => setImmediate(r));
  const seqOf = (p: Uint8Array) => p[4] | (p[5] << 8);
  port.onData(packAck(seqOf(sent[0]), Cmd.Ping, 0)); // the first command's answer, too late
  port.onData(packAck(seqOf(sent[1]), Cmd.GetVersion, 0, Uint8Array.of(22, 0, 2, 0, 1, 1, 0xea, 0x07)));
  const a = await second;
  assert.equal(a.cmd, Cmd.GetVersion);
  assert.equal(a.payload[0], 22);
});

test("while a sweep holds the board, connect, disconnect and detect wait", async () => {
  const b = sim();
  await b.connect("sim");
  let release!: () => void;
  const job = b.withBusy("Bode sweep", () => new Promise<void>((r) => (release = r)));
  await assert.rejects(b.disconnect(), /in use by the Bode sweep/);
  await assert.rejects(b.connect("sim"), /in use by the Bode sweep/);
  await assert.rejects(b.detect(), /in use by the Bode sweep/);
  release();
  await job;
  await b.disconnect();
});

test("a busy serial port is refused in words that name the likely other owner", () => {
  assert.match(openError("/dev/cu.usbserial-110", new Error("Error Resource temporarily unavailable Cannot lock port")), /already open in another program — close Board Test GUI/);
  assert.match(openError("COM5", new Error("Opening COM5: Access denied")), /already open/);
  assert.match(openError("/dev/cu.x", new Error("Error: No such file or directory, cannot open /dev/cu.x")), /unplugged/);
});

test("with serial switched off, only the simulated board is offered", async () => {
  const l = await listBoardPorts();
  assert.equal(l.available, false);
  assert.match(l.error ?? "", /MHO_STUDIO_NO_SERIAL/);
  assert.deepEqual(l.ports.map((p) => p.path), ["sim"]);
});
