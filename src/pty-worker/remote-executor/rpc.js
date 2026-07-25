import {
  encodeRpcMessage,
} from "../remote-executor-contract.js";

export function createDeferred() {
  let resolve = null;
  let reject = null;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

export function createIdGenerator(prefix) {
  let nextId = 1;
  return () => `${prefix}${nextId++}`;
}

export function createSerialMessageQueue() {
  let queue = Promise.resolve();
  return (handler, onError) => {
    queue = queue
      .then(handler)
      .catch(onError);
  };
}

export async function writeMessage(
  stream,
  message,
  { closedMessage = "Remote executor stdin is closed" } = {},
) {
  if (!stream || stream.destroyed || stream.writableEnded) {
    throw new Error(closedMessage);
  }

  const payload = encodeRpcMessage(message);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("drain", onDrain);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };

    stream.on("error", onError);
    const accepted = stream.write(payload, "utf8");
    if (accepted) {
      cleanup();
      resolve();
      return;
    }

    stream.on("drain", onDrain);
  });
}
