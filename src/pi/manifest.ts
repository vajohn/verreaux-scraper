export interface VerreauxManifest {
  schema: 1;
  sourceUrl: string;
  seriesTitle: string;
  adapter: string;
  chapterRange: { from: number; to: number | "latest" };
  generatedAt: string;
}

export interface BuildManifestInput {
  sourceUrl: string;
  seriesTitle: string;
  adapter: string;
  from: number;
  to: number | "latest";
  generatedAt: string;
}

export function buildManifest(input: BuildManifestInput): VerreauxManifest {
  return {
    schema: 1,
    sourceUrl: input.sourceUrl,
    seriesTitle: input.seriesTitle,
    adapter: input.adapter,
    chapterRange: { from: input.from, to: input.to },
    generatedAt: input.generatedAt,
  };
}
