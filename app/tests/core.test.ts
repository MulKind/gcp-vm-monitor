import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateCreditsWaterfall,
  buildSafeKeyFilename,
  computeHostFingerprint,
  isSafeHttpUrl,
  mergeBillingSecrets,
  mergeVmSecrets,
  redactBilling,
  redactVm,
  sanitizeVmHost,
  selectBillingExportTable,
  verifyOrPinHostKey
} from '../src/main/coreLogic.ts'
import type { GcpBillingConfig, VmConfig } from '../src/shared/types.ts'

describe('SSH host key TOFU verification', () => {
  it('pins fingerprint on first connection and rejects mismatched key', () => {
    const keyA = Buffer.from('ssh-ed25519-public-key-bytes-A')
    const keyB = Buffer.from('ssh-ed25519-public-key-bytes-B')

    const first = verifyOrPinHostKey(undefined, keyA)
    assert.equal(first.ok, true)
    assert.equal(first.shouldPin, true)
    assert.ok(first.fingerprint.startsWith('SHA256:'))

    const second = verifyOrPinHostKey(first.fingerprint, keyA)
    assert.equal(second.ok, true)
    assert.equal(second.shouldPin, false)

    const mitm = verifyOrPinHostKey(first.fingerprint, keyB)
    assert.equal(mitm.ok, false)
    assert.equal(mitm.fingerprint, computeHostFingerprint(keyB))
  })
})

describe('Credential DTO redaction and secret merging', () => {
  it('strips secrets from VmConfig DTO and preserves existing secrets on partial edit', () => {
    const stored: VmConfig = {
      id: 'vm-1',
      name: 'Prod',
      kind: 'ssh',
      host: '34.87.24.14',
      port: 22,
      username: 'Klind',
      authType: 'password',
      password: 'top-secret-password',
      passphrase: 'key-passphrase',
      agentToken: 'abcd1234token',
      hostFingerprint: 'SHA256:pinned123',
      agentPort: 9527
    }

    const dto = redactVm(stored)
    assert.equal(dto.password, undefined)
    assert.equal(dto.passphrase, undefined)
    assert.equal(dto.agentToken, undefined)
    assert.equal(dto.hasPassword, true)
    assert.equal(dto.hasPassphrase, true)
    assert.equal(dto.hasAgentToken, true)
    assert.equal(dto.hostFingerprint, 'SHA256:pinned123')

    // Renderer sends back edited name without re-typing password
    const merged = mergeVmSecrets({ ...dto, name: 'Prod Renamed' }, stored)
    assert.equal(merged.password, 'top-secret-password')
    assert.equal(merged.agentToken, 'abcd1234token')
    assert.equal(merged.hostFingerprint, 'SHA256:pinned123')
    assert.equal('hasPassword' in merged, false)

    // Changing host automatically clears stale hostFingerprint
    const hostChanged = mergeVmSecrets({ ...dto, host: '35.1.2.3' }, stored)
    assert.equal(hostChanged.hostFingerprint, undefined)

    // Explicit reset via empty string clears hostFingerprint
    const fpReset = mergeVmSecrets({ ...dto, hostFingerprint: '' }, stored)
    assert.equal(fpReset.hostFingerprint, undefined)
  })

  it('strips serviceAccountJson from GcpBillingConfig DTO and preserves it on edit', () => {
    const stored: GcpBillingConfig = {
      mode: 'bigquery',
      serviceAccountJson: '{"client_email":"sa@test.iam.gserviceaccount.com","private_key":"SECRET"}',
      serviceAccountEmail: 'sa@test.iam.gserviceaccount.com',
      projectId: 'my-proj',
      datasetId: 'billing_export',
      currency: 'USD',
      creditGrants: [],
      autoRefreshMinutes: 30
    }

    const dto = redactBilling(stored)
    assert.equal(dto.serviceAccountJson, undefined)
    assert.equal(dto.hasServiceAccountKey, true)

    const merged = mergeBillingSecrets({ ...dto, autoRefreshMinutes: 60 }, stored)
    assert.equal(merged.serviceAccountJson, stored.serviceAccountJson)
    assert.equal('hasServiceAccountKey' in merged, false)
  })
})

describe('URL boundary, host sanitization, and key filename hardening', () => {
  it('allows only http and https URLs', () => {
    assert.equal(isSafeHttpUrl('https://console.cloud.google.com/billing'), true)
    assert.equal(isSafeHttpUrl('http://127.0.0.1:21000/'), true)
    assert.equal(isSafeHttpUrl('file:///C:/Windows/System32/calc.exe'), false)
    assert.equal(isSafeHttpUrl('javascript:alert(1)'), false)
    assert.equal(isSafeHttpUrl('custom-proto://evil'), false)
  })

  it('prevents path traversal and collisions in generated SSH key filenames', () => {
    const f1 = buildSafeKeyFilename('../../etc/passwd', '11111111-2222-3333-4444-555555555555')
    const f2 = buildSafeKeyFilename('../../etc/passwd', '99999999-2222-3333-4444-555555555555')
    assert.ok(!f1.includes('/') && !f1.includes('\\') && !f1.includes('..'))
    assert.notEqual(f1, f2)
  })

  it('sanitizes pasted URLs and user@host:port in VM host field', () => {
    const vm = sanitizeVmHost({
      id: '1',
      name: 't',
      kind: 'ssh',
      host: 'http://alice@34.87.24.14:2222/panel',
      port: 22,
      username: '',
      authType: 'key',
      agentPort: 9527
    })
    assert.equal(vm.host, '34.87.24.14')
    assert.equal(vm.username, 'alice')
    assert.equal(vm.port, 2222)
  })
})

describe('Strict billing export table matching & waterfall credit allocation', () => {
  it('rejects mismatched or ambiguous billing export tables', () => {
    const tables = [
      'gcp_billing_export_v1_01AAAA_BBBBBB_CCCCCC',
      'gcp_billing_export_v1_01DDDD_EEEEEE_FFFFFF'
    ]
    // Ambiguous multi-account dataset without explicit account ID must throw
    assert.throws(() => selectBillingExportTable(tables), /多个不同结算账户/)

    // Non-existent preferred account ID must throw instead of falling back to first table
    assert.throws(() => selectBillingExportTable(tables, undefined, '019999-888888-777777'), /未找到与结算账户/)

    // Conflict between explicit tableId and preferredBillingId must throw
    assert.throws(
      () => selectBillingExportTable(tables, 'gcp_billing_export_v1_01AAAA_BBBBBB_CCCCCC', '01DDDD-EEEEEE-FFFFFF'),
      /冲突/
    )

    // Exact match succeeds
    assert.equal(
      selectBillingExportTable(tables, undefined, '01DDDD-EEEEEE-FFFFFF'),
      'gcp_billing_export_v1_01DDDD_EEEEEE_FFFFFF'
    )
  })

  it('allocates promo credits in waterfall order without double-counting and zeroes expired grants', () => {
    const breakdown = allocateCreditsWaterfall(
      [
        { id: 'g1', name: 'Grant 1', totalAmount: 100, expiresAt: '2027-01-01' },
        { id: 'g2', name: 'Grant 2', totalAmount: 150, expiresAt: '2027-06-01' },
        { id: 'g3', name: 'Expired Grant', totalAmount: 50, expiresAt: '2025-01-01' }
      ],
      [
        // Expired grant consumes nothing available? Wait: g3 expired 2025-01-01, let's check g1 + g2 with $120 usage in 2026-11
        { creditName: 'Free Trial', usageDate: '2026-11-10', appliedAmount: 80 },
        { creditName: 'Free Trial', usageDate: '2026-11-15', appliedAmount: 40 }
      ],
      '2026-11-25'
    )

    assert.equal(breakdown[0].used, 100)
    assert.equal(breakdown[0].remaining, 0)
    assert.equal(breakdown[1].used, 20)
    assert.equal(breakdown[1].remaining, 130)
    assert.equal(breakdown[2].remaining, 0)
  })
})
