// TESTS — walletWorkerTimingAudit (Wallet Scanner live-regression audit: "job completed... 81.5s.
// Pipeline timing showed ~72.5s" with no accounting for the ~9s gap). Pure builder, no network/KV.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWalletWorkerTimingAudit } from './walletScanWorker'

test('reports the real, previously-unexplained gap between job duration and pipeline duration', () => {
  // Mirrors the reported live shape: ~81.5s job, ~72.5s pipeline, with real pre/post-pipeline time
  // accounting for the rest.
  const audit = buildWalletWorkerTimingAudit({
    jobDurationMs: 81_500,
    pipelineMs: 72_500,
    prePipelineMs: 3_000,
    resultWriteMs: 4_000,
    jobStateWriteMs: 1_500,
    serializationMs: 500,
  })
  assert.equal(audit.jobDurationMs, 81_500)
  assert.equal(audit.pipelineMs, 72_500)
  assert.equal(audit.prePipelineMs, 3_000)
  assert.equal(audit.persistenceMs, 6_000, 'serialization + result write + job-state write')
  assert.equal(audit.postPipelineMs, audit.persistenceMs)
  assert.equal(audit.uiPublishMs, 4_000)
  assert.equal(audit.kvWriteMs, 1_500)
  // 3000 (pre) + 72500 (pipeline) + 6000 (persistence) = 81500 — fully accounted for.
  assert.equal(audit.unexplainedMs, 0)
})

test('slowestUnmeasuredStage picks the larger of pre- and post-pipeline time', () => {
  const postHeavy = buildWalletWorkerTimingAudit({
    jobDurationMs: 10_000, pipelineMs: 8_000, prePipelineMs: 500,
    resultWriteMs: 1_200, jobStateWriteMs: 200, serializationMs: 100,
  })
  assert.equal(postHeavy.slowestUnmeasuredStage, 'post_pipeline_serialization_and_publish')

  const preHeavy = buildWalletWorkerTimingAudit({
    jobDurationMs: 10_000, pipelineMs: 8_000, prePipelineMs: 1_800,
    resultWriteMs: 100, jobStateWriteMs: 50, serializationMs: 20,
  })
  assert.equal(preHeavy.slowestUnmeasuredStage, 'pre_pipeline_imports_and_claim')

  const neither = buildWalletWorkerTimingAudit({
    jobDurationMs: 8_000, pipelineMs: 8_000, prePipelineMs: 0,
    resultWriteMs: 0, jobStateWriteMs: 0, serializationMs: 0,
  })
  assert.equal(neither.slowestUnmeasuredStage, null)
})

test('unexplainedMs surfaces real residual time this audit could not attribute, never goes negative', () => {
  const withResidual = buildWalletWorkerTimingAudit({
    jobDurationMs: 90_000, pipelineMs: 72_500, prePipelineMs: 3_000,
    resultWriteMs: 4_000, jobStateWriteMs: 1_500, serializationMs: 500,
  })
  // 3000 + 72500 + 6000 = 81500 accounted for out of a 90000 total -> 8500 genuinely unexplained.
  assert.equal(withResidual.unexplainedMs, 8_500)

  const overAccounted = buildWalletWorkerTimingAudit({
    // Deliberately inconsistent inputs (accounted-for spans exceed the outer jobDurationMs, which
    // can happen with clock-skew jitter across Date.now() calls) — must clamp to 0, never negative.
    jobDurationMs: 1_000, pipelineMs: 900, prePipelineMs: 200,
    resultWriteMs: 100, jobStateWriteMs: 50, serializationMs: 10,
  })
  assert.equal(overAccounted.unexplainedMs, 0)
})

test('honestly reports supabaseWriteMs and cacheWriteMs as null — no Supabase write and no separately-measured cache write exist in this worker', () => {
  const audit = buildWalletWorkerTimingAudit({
    jobDurationMs: 5_000, pipelineMs: 4_000, prePipelineMs: 500,
    resultWriteMs: 300, jobStateWriteMs: 150, serializationMs: 50,
  })
  assert.equal(audit.supabaseWriteMs, null)
  assert.equal(audit.cacheWriteMs, null)
})

test('a zero-persistence, zero-pre-pipeline run reports a clean, fully-accounted job', () => {
  const audit = buildWalletWorkerTimingAudit({
    jobDurationMs: 5_000, pipelineMs: 5_000, prePipelineMs: 0,
    resultWriteMs: 0, jobStateWriteMs: 0, serializationMs: 0,
  })
  assert.equal(audit.unexplainedMs, 0)
  assert.equal(audit.persistenceMs, 0)
})
