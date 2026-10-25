import { validateMatch, type MatchFile } from "./schema";

/**
 * Decodes match file bytes: gzip (as stored on disk), or plain JSON when a web server has already
 * removed the gzip layer by sending the .gz file with Content-Encoding: gzip (vite preview does).
 * Anything else is an error naming the file.
 */
export async function decodeMatch(data: ArrayBuffer | Uint8Array, where: string): Promise<MatchFile> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(stream).text();
  } else if (bytes.length > 0 && bytes[0] === 0x7b /* { */) {
    text = new TextDecoder().decode(bytes);
  } else {
    throw new Error(`Match file ${where}: not gzip data (expected .json.gz)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Match file ${where}: JSON parse failed (${(e as Error).message})`);
  }
  return validateMatch(raw, where);
}
