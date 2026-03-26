# Customer Support Agent — Domain Spec

## Overview

An autonomous agent that handles customer support — resolving tickets, answering questions,
applying known fixes, escalating when needed, and keeping customers informed. Acts as a
tier-1 support agent with deep product knowledge and empathy.

## Integrations

| Service | Purpose | Auth |
|---------|---------|------|
| Zendesk / Intercom | Ticket management, customer history | API key / OAuth |
| Knowledge Base | Product docs, FAQs, known issues | Internal API |
| Slack | Internal escalation, team notifications | Bot token |
| Email | Customer communication, follow-ups | SMTP / OAuth |
| Product API | Account lookup, feature flags, usage data | Internal API key |

## Goal Types

### 1. Resolve Ticket
- **Trigger:** New ticket assigned or customer message received
- **Flow:** Understand issue → Look up customer → Search knowledge base → Diagnose → Apply fix or answer → Verify → Close
- **Success criteria:** Customer issue resolved, ticket closed with resolution
- **Max steps:** 10

### 2. Escalate Issue
- **Trigger:** Issue beyond tier-1 capability or customer request
- **Flow:** Gather full context → Document investigation → Assign to specialist → Notify customer of escalation
- **Success criteria:** Ticket escalated with complete context, customer informed
- **Max steps:** 6

### 3. Answer Question
- **Trigger:** How-to question or feature inquiry
- **Flow:** Search knowledge base → Find relevant article/docs → Compose answer → Send
- **Success criteria:** Question answered with reference to docs/guide
- **Max steps:** 4

### 4. Handle Billing Inquiry
- **Trigger:** Billing question, refund request, plan change
- **Flow:** Look up account → Check billing history → Explain charges → Apply credit/adjustment if warranted
- **Success criteria:** Billing explained or adjustment applied
- **Max steps:** 6

### 5. Log Feature Request
- **Trigger:** Customer requests a feature
- **Flow:** Search existing requests → Create or upvote → Notify customer of status → Log in CRM
- **Success criteria:** Feature request logged, customer informed of status/timeline
- **Max steps:** 5

## Tool Registry

### Customer & Account
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| get_customer | get_customer | Look up customer account — plan, status, usage, history | Returns account details |
| get_customer_history | get_customer_history | Get customer's ticket history and past interactions | Returns interaction timeline |
| check_account_health | check_account_health | Check account health — feature flags, errors, usage anomalies | Returns health report |
| update_customer | update_customer | Update customer record fields | Customer record updated |

### Ticket Management
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| get_ticket | get_ticket | Get ticket details, messages, and metadata | Returns ticket record |
| update_ticket | update_ticket | Update ticket status, priority, tags, assignee | Ticket updated |
| reply_to_ticket | reply_to_ticket | Send a reply to the customer on the ticket | Reply posted, customer notified |
| create_ticket | create_ticket | Create a new support ticket | Ticket created with unique ID |
| close_ticket | close_ticket | Close a ticket with resolution notes | Ticket closed, satisfaction survey sent |
| escalate_ticket | escalate_ticket | Escalate to specialist team with context | Ticket reassigned with investigation notes |

### Knowledge & Diagnosis
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| search_knowledge_base | search_knowledge_base | Search product docs, FAQs, and help articles | Returns matching articles |
| search_known_issues | search_known_issues | Search known issues database with fixes | Returns matching issues with fixes |
| apply_fix | apply_fix | Apply a known fix to customer's account | Fix applied, issue should be resolved |
| check_service_status | check_service_status | Check product service status and recent incidents | Returns status page info |

### Billing
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| get_billing_history | get_billing_history | Get billing history — charges, invoices, credits | Returns billing records |
| get_plan_details | get_plan_details | Get plan pricing, features, and limits | Returns plan comparison |
| apply_credit | apply_credit | Apply account credit or refund | Credit applied to account |
| change_plan | change_plan | Upgrade/downgrade customer's plan | Plan changed, prorated billing |

### Product Feedback
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| search_feature_requests | search_feature_requests | Search existing feature requests | Returns matching requests with votes |
| create_feature_request | create_feature_request | Create new feature request with customer vote | Request created, vote recorded |
| upvote_feature_request | upvote_feature_request | Add customer's vote to existing request | Vote added, count updated |

### Communication
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| send_email | send_email | Send email to customer | Email delivered |
| notify_slack | notify_slack | Post to internal Slack channel | Message posted |

## Decision Rules

### Priority Assessment
- **P1 (Urgent):** Service down, data loss, security issue, revenue impact
  → Response within 15 minutes, update every 30 minutes
- **P2 (High):** Major feature broken, workaround unavailable
  → Response within 1 hour, update every 2 hours
- **P3 (Medium):** Feature issue with workaround, how-to questions
  → Response within 4 hours
- **P4 (Low):** Feature requests, minor UX issues, general feedback
  → Response within 24 hours

### Escalation Criteria
- Issue requires code changes or deployment
- Data integrity concern
- Security issue (any severity)
- Customer explicitly requests escalation
- Unable to resolve after 3 investigation steps
- VIP/Enterprise customer with SLA

### Refund/Credit Policy
- Service outage affecting customer → auto-approve credit for affected period
- Billing error (overcharge) → auto-approve refund of difference
- "Didn't use the service" → escalate to billing team
- Downgrade with pro-rating → auto-approve credit
- Feature not working as documented → case-by-case, escalate if > $100

## Probe Training Domains

```yaml
training_domains:
  - customer_support
  - ticket_management
  - knowledge_base_search
  - billing_operations
  - customer_communication
```

## Test Scenarios (15)

1. Simple how-to question (answered from knowledge base)
2. Login issue diagnosis and password reset
3. Known issue with available fix (apply it)
4. Unknown issue requiring investigation
5. Billing inquiry — explain charge difference
6. Refund request — legitimate overcharge
7. Feature request — new (create it)
8. Feature request — existing (upvote it)
9. Escalation — complex technical issue
10. VIP customer with SLA — priority handling
11. Multiple issues in one ticket — handle all
12. Angry customer — de-escalation
13. Service outage — status communication
14. Plan upgrade/downgrade request
15. Follow-up on previously unresolved ticket
