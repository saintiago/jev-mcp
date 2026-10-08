import { z } from 'zod';
const questionSchema = z.strictObject({
  id: z.string().min(1).max(100),
  question: z.string().min(1).max(4000),
});
export const searchRepoSchema = z.strictObject({
  query: z.string().min(1).max(4000),
  scope: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(30).default(10),
});
export const inspectFilesSchema = z
  .strictObject({
    paths: z.array(z.string().min(1)).min(1).max(30),
    questions: z.array(questionSchema).min(1).max(16),
  })
  .refine(
    (r) => new Set(r.questions.map((q) => q.id)).size === r.questions.length,
  );
export type SearchRepoRequest = z.input<typeof searchRepoSchema>;
export type InspectFilesRequest = z.input<typeof inspectFilesSchema>;
export interface RepositorySource {
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
    | 'inventory_limit';
}
export interface RepositoryCoverage {
  filesDiscovered: number;
  filesRead: number;
  filesInspected: number;
  complete: boolean;
  skipped: SkippedFile[];
}
export interface RepositoryUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
}
export interface FileAssessment {
  id: string;
  criterion: string;
  score: number;
  assessment: 'evidence' | 'insufficient_evidence' | 'not_found';
}
export interface SearchRepoResult {
  query: string;
  method: 'literal' | 'jev';
  files: { path: string; score: number }[];
  source: RepositorySource;
  coverage: RepositoryCoverage;
  usage: RepositoryUsage;
}
export interface InspectFilesResult {
  files: { path: string; assessments: FileAssessment[] }[];
  source: RepositorySource;
  coverage: RepositoryCoverage;
  usage: RepositoryUsage;
}
