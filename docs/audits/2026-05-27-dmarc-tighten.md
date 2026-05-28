# DMARC Tighten 25 → 100 — 2026-05-27

Audit 2 H11 P2.

## Before

```
"v=DMARC1; p=quarantine; rua=mailto:d3edc8cc8eed489194b60c5f81dc3779@dmarc-reports.cloudflare.net,mailto:dmarc@buyhalfcow.com; ruf=mailto:dmarc@buyhalfcow.com; pct=25; adkim=r; aspf=r; sp=quarantine"
```

- Record ID: `30f2c3c3f757acf93f450042fa6c3bca`
- Last modified: 2026-05-20T18:31:57Z
- Effective enforcement: only 25% of failing mail quarantined.

## After

```
"v=DMARC1; p=quarantine; rua=mailto:d3edc8cc8eed489194b60c5f81dc3779@dmarc-reports.cloudflare.net,mailto:dmarc@buyhalfcow.com; ruf=mailto:dmarc@buyhalfcow.com; pct=100; adkim=r; aspf=r; sp=quarantine"
```

- Updated: 2026-05-27T06:49:33Z via Cloudflare API PATCH.
- Effective enforcement: 100% of failing mail quarantined.

## Verification

```
$ dig +short TXT _dmarc.buyhalfcow.com
"v=DMARC1; p=quarantine; rua=mailto:d3edc8cc8eed489194b60c5f81dc3779@dmarc-reports.cloudflare.net,mailto:dmarc@buyhalfcow.com; ruf=mailto:dmarc@buyhalfcow.com; pct=100; adkim=r; aspf=r; sp=quarantine"
```

Confirms `pct=100` active.

## Rationale

Soft 25% quarantine was acceptable during early sender-rep warming.
At paid-ad scale we need full enforcement to:
- Stop spoofing of buyhalfcow.com (protects brand at scale)
- Tighten alignment so Gmail/Outlook reputation accumulates faster
- Maximize signal from aggregate reports (rua=) since 100% of failures now traverse the policy

## Post-deploy monitoring

Operator should monitor DMARC aggregate reports (rua=) for 7 days.
If failure rate climbs above ~1%, investigate before sustained scale.

Key reports inbox: `dmarc@buyhalfcow.com` + Cloudflare aggregate
(`d3edc8cc8eed489194b60c5f81dc3779@dmarc-reports.cloudflare.net`).

## Rollback

If failure rate spikes:

```
CF_TOKEN="<token>"
ZONE="0761123c9b4d4001222c1678269dac42"
DMARC_ID="30f2c3c3f757acf93f450042fa6c3bca"

curl -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/$DMARC_ID" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"v=DMARC1; p=quarantine; rua=mailto:d3edc8cc8eed489194b60c5f81dc3779@dmarc-reports.cloudflare.net,mailto:dmarc@buyhalfcow.com; ruf=mailto:dmarc@buyhalfcow.com; pct=50; adkim=r; aspf=r; sp=quarantine"}'
```

Step down to pct=50 first; only revert fully to pct=25 if 50% is also too aggressive.
