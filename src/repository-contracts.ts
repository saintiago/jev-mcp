import { z } from 'zod';
import type { JevErrorCode } from './errors.js';
export const retrieveEvidenceSchema = z
  .strictObject({
    question: z.string().trim().min(1).max(4000).optional(),
    scope: z.string().min(1).default('.'),
    terms: z.array(z.string().min(1).max(200)).max(16).default([]),
    maxChars: z.number().int().min(1000).max(64000).default(16000),
  })
  .refine((r) => r.question !== undefined || r.terms.length > 0);
export const expandEvidenceSchema = z.strictObject({
  requests: z
    .array(
      z
        .strictObject({
          path: z.string().min(1),
          start: z.number().int().positive().optional(),
          end: z.number().int().positive().optional(),
          full: z.boolean().default(false),
        })
        .refine(
          (r) =>
            !(r.full && (r.start !== undefined || r.end !== undefined)) &&
            (r.end === undefined || r.end >= (r.start ?? 1)),
        ),
    )
    .min(1)
    .max(30),
});
export type RetrieveEvidenceRequest = z.input<typeof retrieveEvidenceSchema>;
export type ExpandEvidenceRequest = z.input<typeof expandEvidenceSchema>;
export interface RepositorySource {
  root: string;
  revision: string;
  workingTreeDirty: boolean;
  contentDigest: string;
}
export interface SkippedFile {
  path: string;
  reason:
    | 'outside_repository'
    | 'ignored'
    | 'unreadable'
    | 'binary'
    | 'too_large'
    | 'inventory_limit'
    | 'evaluation_failed';
  errorCode?: JevErrorCode;
}
export interface RepositoryCoverage {
  filesDiscovered: number;
  filesRead: number;
  filesInspected: number;
  complete: boolean;
  skipped: SkippedFile[];
  limits: ('inventory' | 'candidates' | 'budget' | 'semantic_filter')[];
}
export interface RepositoryUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}
export interface EvidenceWindow {
  path: string;
  start: number;
  end: number;
  text: string;
}
export interface EvidenceFile {
  path: string;
  totalLines: number;
  omitted: boolean;
}
export interface EvidenceResult {
  method: 'exact' | 'semantic' | 'expanded';
  files: EvidenceFile[];
  windows: EvidenceWindow[];
  source: RepositorySource;
  coverage: RepositoryCoverage;
  usage: RepositoryUsage;
  notice: string;
}
