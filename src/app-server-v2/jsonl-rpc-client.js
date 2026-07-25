import readline from "node:readline";

import { createErrorFromJsonRpc, safeJsonParse } from "../pty-worker/codex-runner-common.js";

function createClosedError(label) {
  return new Error(`${label} JSON-RPC transport closed`);
}

function encodeRpcMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

function normalizeServerRequestResult(value) {
  if (value && typeof value === "object" && "result" in value) {
    return value.result;
  }

  return value ?? {};
}

function normalizeServerRequestError(error, fallbackMessage) {
  if (error && typeof error === "object" && error.jsonrpcError) {
    return error.jsonrpcError;
  }

  return {
    code: Number.isFinite(error?.code) ? error.code : -32000,
    message: error?.message || fallbackMessage,
    data: error?.data ?? null,
  };
}

export function createJsonLineRpcClient({
  input,
  output,
  label = "Codex app-server",
  onNotification = null,
  onRequest = null,
  onWarning = null,
  onDisconnect = null,
} = {}) {
  if (!input || !output) {
    throw new Error("createJsonLineRpcClient requires input and output streams");
  }

  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const reader = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });

  function settlePending(error) {
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  }

  function writeMessage(message) {
    if (closed || output.destroyed || output.writableEnded) {
      throw createClosedError(label);
    }

    output.write(encodeRpcMessage(message), "utf8");
  }

  async function handleServerRequest(message) {
    const id = message.id;
    try {
      if (typeof onRequest !== "function") {
        throw new Error(`Unsupported app-server request: ${message.method}`);
      }

      const result = normalizeServerRequestResult(
        await onRequest({
          method: message.method,
          params: message.params ?? {},
          id,
          raw: message,
        }),
      );
      writeMessage({
        jsonrpc: "2.0",
        id,
        result,
      });
    } catch (error) {
      writeMessage({
        jsonrpc: "2.0",
        id,
        error: normalizeServerRequestError(
          error,
          `App-server request ${message.method} failed`,
        ),
      });
    }
  }

  reader.on("line", (line) => {
    const raw = String(line || "").trim();
    if (!raw) {
      return;
    }

    const message = safeJsonParse(raw);
    if (!message || typeof message !== "object") {
      onWarning?.(`${label} emitted malformed JSON-RPC line`);
      return;
    }

    if (message.id !== undefined && !message.method) {
      const entry = pending.get(message.id);
      if (!entry) {
        onWarning?.(`${label} returned unknown JSON-RPC response id: ${message.id}`);
        return;
      }

      pending.delete(message.id);
      if (message.error) {
        entry.reject(
          createErrorFromJsonRpc(message.error, `${label} request ${entry.method} failed`),
        );
        return;
      }

      entry.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      void handleServerRequest(message).catch((error) => {
        onWarning?.(`${label} server-request response failed: ${error?.message || error}`);
      });
      return;
    }

    if (message.method) {
      onNotification?.(message);
    }
  });

  function closeWithError(error) {
    if (closed) {
      return;
    }

    closed = true;
    settlePending(error);
    onDisconnect?.(error);
  }

  reader.on("close", () => {
    closeWithError(createClosedError(label));
  });
  input.on?.("error", (error) => closeWithError(error));
  output.on?.("error", (error) => closeWithError(error));

  return {
    request(method, params = {}, { timeoutMs = 0 } = {}) {
      if (closed) {
        return Promise.reject(createClosedError(label));
      }

      const id = nextId;
      nextId += 1;

      return new Promise((resolve, reject) => {
        let timer = null;
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${label} request ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }
        pending.set(id, {
          method,
          resolve(value) {
            if (timer) {
              clearTimeout(timer);
            }
            resolve(value);
          },
          reject(error) {
            if (timer) {
              clearTimeout(timer);
            }
            reject(error);
          },
        });

        try {
          writeMessage({
            jsonrpc: "2.0",
            id,
            method,
            params,
          });
        } catch (error) {
          if (timer) {
            clearTimeout(timer);
          }
          pending.delete(id);
          reject(error);
        }
      });
    },

    notify(method, params = undefined) {
      writeMessage({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      });
    },

    respond(id, result = {}) {
      writeMessage({
        jsonrpc: "2.0",
        id,
        result,
      });
    },

    reject(id, error) {
      writeMessage({
        jsonrpc: "2.0",
        id,
        error: normalizeServerRequestError(error, "App-server request rejected"),
      });
    },

    close() {
      if (closed) {
        return;
      }

      closed = true;
      reader.close();
      settlePending(createClosedError(label));
      try {
        output.end();
      } catch {}
    },
  };
}
