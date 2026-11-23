import test from "node:test";
import assert from "node:assert/strict";
import { CameraStartup, keepCameraResource } from "../src/cameraStartup.ts";

test("closing a camera dialog disposes a late stream and serializes starts across dialogs", async () => {
  const first = new CameraStartup();
  const reopened = new CameraStartup();
  const stream = Promise.withResolvers();
  let disposed = 0;
  let attached = false;
  const pending = first.run(async (signal) => {
    const resource = await stream.promise;
    attached = keepCameraResource(resource, signal, (value) => value.stop());
  });
  assert.equal(await first.run(async () => assert.fail("parallel start")), false);
  first.cancel();
  assert.equal(await reopened.run(async () => assert.fail("overlapping browser permission request")), false);
  stream.resolve({ stop() { disposed++; } });
  assert.equal(await pending, true);
  assert.equal(disposed, 1);
  assert.equal(attached, false);
  assert.equal(await reopened.run(async (signal) => assert.equal(signal.aborted, false)), true);
});

test("a late model is closed after cancellation and is never attached", async () => {
  const startup = new CameraStartup();
  const model = Promise.withResolvers();
  let closed = 0;
  const pending = startup.run(async (signal) => {
    const runtime = await model.promise;
    assert.equal(keepCameraResource(runtime, signal, (value) => value.close()), false);
  });
  startup.cancel();
  model.resolve({ close() { closed++; } });
  await pending;
  assert.equal(closed, 1);
});

test("a failed camera start releases the lock and a successful retry keeps its resources", async () => {
  const startup = new CameraStartup();
  await assert.rejects(startup.run(async () => { throw new Error("camera busy"); }), /camera busy/);
  assert.equal(await startup.run(async (signal) => {
    assert.equal(keepCameraResource({}, signal, () => assert.fail("disposed active resource")), true);
  }), true);
});
