/**
 * T3 Outputs: artifacts as user-facing outputs, reading and reviewing them (spec 20261029
 * §1.5, §2.2, §3.4, §3.5). Schemas are fixed by the Core track; T3 implements them.
 */
import { z } from 'zod';
import { ArtifactId, IntegrationId } from '../common';
import { Artifact } from '../domain';
import { type MethodDef, params } from '../method';

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** Kinds an agent publishes (code changes are recorded from the worktree, not published). */
export const PublishKind = z.enum(['document', 'data', 'link', 'files']);
export type PublishKind = z.infer<typeof PublishKind>;

/** Size limits of published outputs. */
export const OUTPUT_LIMITS = {
  documentChars: 1_000_000,
  dataRows: 5_000,
  dataBytes: 2_000_000,
  files: 500,
  readDefaultBytes: 64 * 1024,
  readMaxBytes: 1_000_000,
} as const;

export const ReviewDecision = z.enum(['accept', 'redo']);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

export const outputsDomain = { PublishKind, ReviewDecision, OUTPUT_LIMITS } as const;

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export const outputsMethods = {
  'artifact.publish': {
    params: params({
      kind: PublishKind,
      title: z.string().min(1).max(200),
      summary: z.string().max(300).optional().describe('One line'),
      content: z
        .string()
        .max(OUTPUT_LIMITS.documentChars)
        .optional()
        .describe('document: the text (markdown or plain)'),
      format: z
        .string()
        .max(20)
        .optional()
        .describe('document: markdown (default) | text; data: csv | json'),
      path: z
        .string()
        .min(1)
        .max(4000)
        .optional()
        .describe('document / data: a file in your workspace to publish instead of content'),
      paths: z
        .array(z.string().min(1).max(4000))
        .max(OUTPUT_LIMITS.files)
        .optional()
        .describe('files: files or folders in your workspace'),
      columns: z.array(z.string().max(200)).max(200).optional().describe('data: column names'),
      rows: z
        .array(z.array(z.unknown()))
        .max(OUTPUT_LIMITS.dataRows)
        .optional()
        .describe('data: rows'),
      url: z.string().min(1).max(4000).optional().describe('link: the URL'),
    }),
    result: Artifact,
    description:
      'Leave an output of your work: a document (text), data (a table), a link, or files in your workspace. Publish what the requester should look at; it is shown as your result. Paths must be inside your workspace.',
    mutates: true,
  },
  'artifact.read': {
    params: params({
      artifactId: ArtifactId,
      path: z.string().min(1).max(4000).optional().describe('files: which file to read'),
      offset: z.int().nonnegative().default(0),
      limit: z.int().min(1).max(OUTPUT_LIMITS.readMaxBytes).default(OUTPUT_LIMITS.readDefaultBytes),
    }),
    result: z.object({
      content: z.string(),
      mimeType: z.string().nullable(),
      truncated: z.boolean(),
    }),
    description:
      'Read the content of an output (a document, data as CSV, or one file of a files output), in pages.',
  },
  'artifact.review': {
    params: params({
      artifactId: ArtifactId,
      decision: ReviewDecision,
      note: z.string().max(20_000).optional().describe('redo: what to change'),
    }),
    result: z.object({
      artifact: Artifact,
      integrationId: IntegrationId.nullable().describe('Integration created to apply code changes'),
    }),
    description:
      'Accept an output, or send the work back to the same child with a note (redo). Accepting code changes applies them and is for humans only.',
    mutates: true,
  },
} as const satisfies Record<string, MethodDef>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const outputsEvents = {
  /** An artifact changed after it was created (its review state). */
  'artifact.updated': z.object({ artifact: Artifact, changes: z.array(z.string()) }),
} as const;
