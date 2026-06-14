/**
 * Minimal decoder for AWS's `application/vnd.amazon.eventstream` framing, used
 * by Bedrock's `invoke-with-response-stream` endpoint.
 *
 * Each message on the wire is:
 *   [ total_len:4 ][ headers_len:4 ][ prelude_crc:4 ][ headers ][ payload ][ msg_crc:4 ]
 * (all integers big-endian). For Bedrock streaming the payload is a JSON object
 * `{ "bytes": "<base64>" }` whose decoded bytes are the model's native chunk
 * event (for Anthropic: `message_start`, `content_block_delta`, …).
 *
 * This decoder is a pure async transform: feed it the response byte stream and
 * it yields each decoded payload-JSON object as soon as a full frame arrives —
 * which is what makes Claude responses stream token-by-token.
 */

/** Decode a single eventstream message payload into its inner JSON object. */
function decodePayload(payload: Buffer): Record<string, unknown> | null {
  try {
    const outer = JSON.parse(payload.toString('utf8')) as { bytes?: string };
    if (typeof outer.bytes === 'string') {
      const inner = Buffer.from(outer.bytes, 'base64').toString('utf8');
      return JSON.parse(inner) as Record<string, unknown>;
    }
    // Some frames (e.g. errors) carry the JSON directly.
    return outer as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Decode an AWS eventstream byte stream into inner chunk-event JSON objects,
 * yielding each as soon as its frame is complete.
 */
export async function* decodeEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  let buf = Buffer.alloc(0);

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);

      // Parse as many complete frames as the buffer currently holds.
      for (;;) {
        if (buf.length < 12) break; // need at least the prelude
        const totalLen = buf.readUInt32BE(0);
        if (totalLen < 16 || totalLen > 50_000_000) {
          // Corrupt framing — bail out to avoid spinning.
          return;
        }
        if (buf.length < totalLen) break; // wait for the rest of the frame

        const headersLen = buf.readUInt32BE(4);
        const payloadStart = 12 + headersLen;
        const payloadEnd = totalLen - 4; // minus trailing message CRC
        const payload = buf.subarray(payloadStart, payloadEnd);

        const event = decodePayload(payload);
        if (event !== null) {
          yield event;
        }
        buf = buf.subarray(totalLen);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
