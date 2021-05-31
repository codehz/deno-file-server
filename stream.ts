import { RangeNotSatisfiable } from "./errors.ts";
import { readableStreamFromReader } from "https://deno.land/std@0.97.0/io/streams.ts";

export interface Range {
  start: number;
  end?: number;
}

const FULL_RANGE: Range = { start: 0 };

export function parseRange(text: string): Range {
  const matched = text.match(
    /^bytes=\s*(?<start>\d+)\s*-\s*(?:(?<end>\d+)\s*)?$/,
  );
  if (matched != null) {
    return {
      start: +(matched.groups!.start),
      end: +(matched.groups!.end ?? Number.MAX_SAFE_INTEGER),
    };
  } else {
    throw new RangeNotSatisfiable("not implemented");
  }
}

class LimitedReaderWithCloser implements Deno.Reader, Deno.Closer {
  constructor(public reader: Deno.Reader & Deno.Closer, public limit: number) {}

  async read(p: Uint8Array): Promise<number | null> {
    if (this.limit <= 0) {
      return null;
    }

    if (p.length > this.limit) {
      p = p.subarray(0, this.limit);
    }
    const n = await this.reader.read(p);
    if (n == null) {
      return null;
    }

    this.limit -= n;
    return n;
  }
  close(): void {
    this.reader.close();
  }
}

export async function toReadableStream(
  file: Deno.File,
  { start, end = Number.MAX_SAFE_INTEGER }: Range = FULL_RANGE,
) {
  const remain = end - start + 1;
  if (remain < 1) {
    throw new RangeNotSatisfiable(
      "end position should equal or greater than start position",
    );
  }
  await file.seek(start, Deno.SeekMode.Start);
  return readableStreamFromReader(new LimitedReaderWithCloser(file, remain));
}
