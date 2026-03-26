# DevOps Incident Response Agent — Domain Spec

## Overview

An autonomous agent that triages, diagnoses, and resolves infrastructure incidents.
Operates as first responder: receives alerts, investigates root cause, executes runbooks,
escalates when needed, and keeps the team informed throughout.

## Integrations

| Service | Purpose | Auth |
|---------|---------|------|
| PagerDuty | Alert ingestion, incident lifecycle, escalation | API token |
| Datadog | Metrics, logs, APM traces, dashboards | API + App key |
| AWS | EC2, ECS, RDS, CloudWatch, Lambda, S3 | IAM role / access key |
| GitHub | Deployment history, recent PRs, rollback triggers | Personal access token |
| Slack | Team notifications, status updates, war room | Bot token |

## Goal Types

### 1. Resolve Incident
- **Trigger:** PagerDuty alert or manual escalation
- **Flow:** Acknowledge → Triage severity → Investigate metrics/logs → Identify root cause → Execute fix → Verify → Resolve
- **Success criteria:** Service health restored, incident resolved in PagerDuty
- **Max steps:** 15

### 2. Investigate Alert
- **Trigger:** Anomaly alert from Datadog
- **Flow:** Check metrics → Check logs → Correlate with deployments → Determine if action needed → Report findings
- **Success criteria:** Root cause identified with confidence assessment
- **Max steps:** 10

### 3. Perform Runbook
- **Trigger:** Manual request or automated trigger
- **Flow:** Load runbook → Validate preconditions → Execute steps in order → Verify each step → Report completion
- **Success criteria:** All runbook steps completed successfully
- **Max steps:** 20

### 4. Post-Incident Review
- **Trigger:** After incident resolution
- **Flow:** Gather timeline → Collect metrics → Identify contributing factors → Draft summary → Post to Slack
- **Success criteria:** PIR document generated with timeline and action items
- **Max steps:** 8

## Tool Registry

### Monitoring & Observability
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| check_metrics | check_metrics | Query Datadog metrics (CPU, memory, error rate, latency, throughput) for a service | Returns metric values with timestamps |
| check_logs | check_logs | Query Datadog logs with filters (service, severity, time range, pattern) | Returns matching log entries |
| check_apm | check_apm | Query Datadog APM traces for a service | Returns trace data with latency breakdown |
| get_dashboard | get_dashboard | Get a Datadog dashboard snapshot | Returns dashboard URL and key metric summary |

### Incident Management
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| acknowledge_incident | acknowledge_incident | Acknowledge a PagerDuty incident | Incident status → acknowledged |
| resolve_incident | resolve_incident | Resolve a PagerDuty incident with notes | Incident status → resolved |
| escalate_incident | escalate_incident | Escalate to next responder in PagerDuty | Incident escalated, next responder paged |
| add_incident_note | add_incident_note | Add a note to the PagerDuty incident timeline | Note added to incident |
| get_incident | get_incident | Get PagerDuty incident details | Returns incident info, timeline, responders |

### Infrastructure Actions
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| restart_service | restart_service | Restart an ECS service or EC2 instance | Service restarted, connections reset |
| scale_service | scale_service | Scale ECS service desired count or ASG | Replica count adjusted |
| rollback_deployment | rollback_deployment | Trigger GitHub deployment rollback to previous version | Previous version deployed |
| update_config | update_config | Update service configuration via Parameter Store | Config updated, may require restart |
| run_healthcheck | run_healthcheck | Execute health check against service endpoints | Returns health status per endpoint |
| check_deployment_status | check_deployment_status | Check current deployment version and status | Returns version, health, rollback availability |

### AWS-Specific
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| check_rds | check_rds | Check RDS instance status, connections, replication lag | Returns DB health metrics |
| check_cloudwatch | check_cloudwatch | Query CloudWatch alarms and metrics | Returns alarm states and metric data |
| check_lambda | check_lambda | Check Lambda function errors and throttles | Returns invocation metrics |
| modify_security_group | modify_security_group | Add/remove security group rules | Network rules updated |

### Communication
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| notify_team | notify_team | Post to Slack channel with incident update | Message posted to channel |
| create_war_room | create_war_room | Create a Slack channel for incident coordination | Channel created, responders invited |
| post_status_update | post_status_update | Post formatted status update with severity and ETA | Status update posted |

### Knowledge
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| search_runbooks | search_runbooks | Search runbook database for relevant procedures | Returns matching runbooks |
| search_past_incidents | search_past_incidents | Search past incident records for similar issues | Returns similar incidents with resolutions |
| get_service_owners | get_service_owners | Look up service ownership and escalation contacts | Returns team and contact info |

## Decision Rules

### Severity Assessment
- **P1 (Critical):** Revenue-impacting, customer-facing outage, data loss risk
  → Immediate action, create war room, page on-call
- **P2 (High):** Degraded service, elevated error rates > 5%
  → Investigate within 5 minutes, notify team
- **P3 (Medium):** Non-critical service issues, elevated latency
  → Investigate within 15 minutes, log findings
- **P4 (Low):** Informational alerts, minor anomalies
  → Log and monitor, no immediate action needed

### Escalation Criteria
- Unable to identify root cause after 10 minutes of investigation
- Fix requires permissions the agent doesn't have
- Multiple services affected (potential cascading failure)
- Data integrity concerns
- Customer data exposure risk

### Rollback Decision
- Error rate > 10% AND correlates with recent deployment → rollback immediately
- Error rate 5-10% AND new deployment in last 2 hours → investigate, prepare rollback
- Latency P95 > 2x baseline AND recent deployment → prepare rollback, notify team

## Probe Training Domains

```yaml
training_domains:
  - devops_incident
  - infrastructure_management
  - monitoring_observability
  - cloud_operations
  - incident_communication
```

## Test Scenarios (15)

1. Simple service restart (single failing container)
2. Database connection pool exhaustion
3. Deployment caused elevated error rate → rollback
4. Memory leak causing OOM kills
5. DNS resolution failure
6. SSL certificate expiring in < 24h
7. DDoS-like traffic spike
8. Cascading failure across 3 services
9. RDS replication lag > 30s
10. Lambda cold start latency spike
11. Disk space exhaustion on ECS host
12. Configuration drift after deployment
13. Third-party API degradation (external dependency)
14. Runbook execution: database failover
15. Post-incident review generation
