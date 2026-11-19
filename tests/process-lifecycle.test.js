"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  trackChildProcess,
  cancellationError,
  timeoutError,
} = require("../process-lifecycle");

function fakeProcess() {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;
  proc.killCalls = [];

  proc.kill = function (signal) {
    this.killed = true;
    this.killCalls.push(signal);
    return true;
  };

  return proc;
}

test("tracks a process and removes it after close", () => {
  const proc = fakeProcess();
  const job = { cancelled: false, proc: null };

  trackChildProcess(proc, job, { timeoutMs: 10_000 });

  assert.equal(job.proc, proc);
  assert.equal(job.processes.has(proc), true);

  proc.exitCode = 0;
  proc.emit("close", 0, null);

  assert.equal(job.processes.has(proc), false);
  assert.equal(job.proc, null);
});

test("cancellation aborts every tracked process", () => {
  const controller = new AbortController();
  const job = {
    cancelled: false,
    proc: null,
    abortController: controller,
  };
  const first = fakeProcess();
  const second = fakeProcess();

  trackChildProcess(first, job, { timeoutMs: 10_000 });
  trackChildProcess(second, job, { timeoutMs: 10_000 });

  controller.abort();

  assert.deepEqual(first.killCalls, ["SIGKILL"]);
  assert.deepEqual(second.killCalls, ["SIGKILL"]);

  first.emit("close", null, "SIGKILL");
  second.emit("close", null, "SIGKILL");
});

test("keeps job.proc pointed at a remaining child when another child closes", () => {
  const job = { cancelled: false, proc: null };
  const first = fakeProcess();
  const second = fakeProcess();

  trackChildProcess(first, job, { timeoutMs: 10_000 });
  trackChildProcess(second, job, { timeoutMs: 10_000 });

  assert.equal(job.proc, second);

  first.exitCode = 0;
  first.emit("close", 0, null);

  assert.equal(job.processes.has(first), false);
  assert.equal(job.processes.has(second), true);
  assert.equal(job.proc, second);

  second.exitCode = 0;
  second.emit("close", 0, null);

  assert.equal(job.proc, null);
  assert.equal(job.processes.size, 0);
});

test("escalates termination when a signal was sent but the child is still running", () => {
  const controller = new AbortController();
  const job = { cancelled: false, proc: null, abortController: controller };
  const proc = fakeProcess();

  // Node's killed flag only means a signal was sent; the child may still run.
  proc.killed = true;
  trackChildProcess(proc, job, { timeoutMs: 10_000 });

  controller.abort();

  assert.deepEqual(proc.killCalls, ["SIGKILL"]);
  proc.signalCode = "SIGKILL";
  proc.emit("close", null, "SIGKILL");
});

test("immediately terminates a process when its job is already cancelled", () => {
  const proc = fakeProcess();
  const job = { cancelled: true, proc: null };

  trackChildProcess(proc, job, { timeoutMs: 10_000 });

  assert.deepEqual(proc.killCalls, ["SIGKILL"]);
  proc.emit("close", null, "SIGKILL");
});

test("exposes consistent cancellation and timeout errors", () => {
  assert.equal(cancellationError().message, "CANCELLED");
  assert.equal(cancellationError().code, "PROCESS_CANCELLED");
  assert.equal(timeoutError("ffprobe", 100).code, "PROCESS_TIMEOUT");
});

test("rejects invalid timeout configuration", () => {
  const proc = fakeProcess();

  assert.throws(
    () => trackChildProcess(proc, null, { timeoutMs: 0 }),
    /positive finite number/
  );
});

test("kills a real child process when its timeout expires", async () => {
  const { spawn } = require("node:child_process");
  const proc = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
  const tracking = trackChildProcess(proc, null, {
    timeoutMs: 100,
    label: "test child",
  });

  const [code, signal] = await new Promise((resolve, reject) => {
    proc.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    proc.once("error", reject);
  });

  assert.equal(tracking.timedOut, true);
  assert.equal(signal, "SIGKILL");
  assert.notEqual(code, 0);
});

test("kills a real child process when its job is cancelled", async () => {
  const { spawn } = require("node:child_process");
  const controller = new AbortController();
  const job = { cancelled: false, abortController: controller };
  const proc = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
  ]);

  trackChildProcess(proc, job, { timeoutMs: 3000 });

  const closed = new Promise((resolve, reject) => {
    proc.once("close", (code, signal) => resolve({ code, signal }));
    proc.once("error", reject);
  });

  controller.abort();

  const result = await closed;
  assert.equal(result.signal, "SIGKILL");
  assert.equal(job.processes.has(proc), false);
});
