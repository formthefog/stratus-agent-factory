# Sales Pipeline Agent — Domain Spec

## Overview

An autonomous agent that manages the sales pipeline — qualifying leads, progressing deals,
scheduling meetings, drafting follow-ups, and keeping the CRM current. Acts as a tireless
sales ops assistant that ensures no deal falls through the cracks.

## Integrations

| Service | Purpose | Auth |
|---------|---------|------|
| Salesforce / HubSpot | CRM — contacts, deals, activities, pipeline | OAuth / API key |
| Gmail / Outlook | Email — read, draft, send, search | OAuth |
| Google Calendar | Scheduling — availability, events, meetings | OAuth |
| LinkedIn (Sales Nav) | Research — company info, connections, signals | API key |
| Slack | Internal notifications, deal alerts | Bot token |

## Goal Types

### 1. Progress Deal
- **Trigger:** Deal stale > N days, or stage change needed
- **Flow:** Review deal context → Check recent activity → Identify next step → Execute (email, meeting, task) → Update CRM
- **Success criteria:** Deal advanced to next stage or clear next action created
- **Max steps:** 8

### 2. Qualify Lead
- **Trigger:** New inbound lead or manual assignment
- **Flow:** Research company → Check fit criteria → Enrich contact → Score lead → Update CRM with qualification
- **Success criteria:** Lead scored and qualified/disqualified with reasoning
- **Max steps:** 6

### 3. Schedule Meeting
- **Trigger:** Deal needs meeting or follow-up call
- **Flow:** Check calendar → Find mutual availability → Draft invite → Send → Confirm
- **Success criteria:** Meeting scheduled with all parties
- **Max steps:** 5

### 4. Send Follow-Up
- **Trigger:** Post-meeting, deal stale, or nurture sequence
- **Flow:** Review deal context → Review meeting notes → Draft personalized email → Send → Log activity
- **Success criteria:** Follow-up sent and logged in CRM
- **Max steps:** 5

### 5. Pipeline Report
- **Trigger:** Weekly/daily request or scheduled
- **Flow:** Pull all deals → Group by stage → Calculate metrics → Generate report → Distribute
- **Success criteria:** Report generated with pipeline value, stage distribution, stale deals, forecast
- **Max steps:** 4

## Tool Registry

### CRM Operations
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| get_contact | get_contact | Get contact record with full history | Returns contact details, activities, deals |
| update_contact | update_contact | Update contact fields (stage, score, owner) | Contact record updated |
| search_contacts | search_contacts | Search contacts by name, company, or criteria | Returns matching contacts |
| get_deal | get_deal | Get deal record with stage, value, activities | Returns deal details |
| update_deal | update_deal | Update deal stage, value, or fields | Deal record updated |
| search_deals | search_deals | Search deals by stage, owner, value, stale days | Returns matching deals |
| create_deal | create_deal | Create new deal linked to contact | Deal created in pipeline |
| add_activity | add_activity | Log an activity (call, email, meeting) to contact | Activity recorded in CRM |
| create_task | create_task | Create follow-up task with due date | Task created and assigned |
| get_pipeline_metrics | get_pipeline_metrics | Get pipeline summary — total value, count by stage, conversion rates | Returns pipeline analytics |

### Email
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| search_emails | search_emails | Search email threads with a contact | Returns matching email threads |
| draft_email | draft_email | Draft a personalized email based on deal context | Draft created for review |
| send_email | send_email | Send an email to a contact | Email delivered, activity logged |
| get_email_thread | get_email_thread | Get full email thread for context | Returns email thread |

### Calendar
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| check_calendar | check_calendar | Check calendar availability for a date range | Returns free/busy slots |
| schedule_meeting | schedule_meeting | Create calendar event with attendees | Meeting created, invites sent |
| get_upcoming_meetings | get_upcoming_meetings | Get meetings in next N days | Returns scheduled meetings |

### Research
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| research_company | research_company | Research company via LinkedIn/web — size, funding, tech stack | Returns company profile |
| research_contact | research_contact | Research contact — role, tenure, LinkedIn activity | Returns contact insights |
| check_signals | check_signals | Check buying signals — job postings, funding, tech changes | Returns signal indicators |

### Communication
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| notify_slack | notify_slack | Post deal update to sales Slack channel | Message posted |
| draft_summary | draft_summary | Generate structured summary of deal or pipeline | Summary text generated |

## Decision Rules

### Lead Qualification (BANT)
- **Budget:** Company size > 50 employees OR Series A+ funding → likely has budget
- **Authority:** Title contains VP/Director/Head/C-level → decision maker
- **Need:** Pain points align with our solution → qualified need
- **Timeline:** Active buying signals (job posts, tech stack changes) → near-term timeline

Score: 0-100. Qualified ≥ 60. Fast-track ≥ 80.

### Deal Progression Rules
- Demo → Proposal: Champion identified, technical fit confirmed, budget discussed
- Proposal → Negotiation: Proposal sent, positive response received
- Negotiation → Closed Won: Terms agreed, contract signed
- Any stage → Closed Lost: Explicit rejection, no response after 3 follow-ups, competitor chosen

### Follow-Up Timing
- Post-demo: Follow up within 24 hours
- Post-proposal: Follow up after 3 business days
- Stale deal (no activity 7+ days): Automated check-in
- Stale deal (14+ days): Escalate to account owner
- Stale deal (30+ days): Consider Closed Lost

### Email Personalization
- Always reference specific details from last interaction
- Mention their company/role, not generic templates
- Keep emails under 150 words for follow-ups
- Include clear CTA (call to action) — question, meeting link, or next step

## Probe Training Domains

```yaml
training_domains:
  - sales_pipeline
  - crm_management
  - email_outreach
  - lead_qualification
  - meeting_scheduling
```

## Test Scenarios (15)

1. Qualify a warm inbound lead (BANT scoring)
2. Progress demo-stage deal to proposal
3. Draft and send post-meeting follow-up
4. Schedule meeting with prospect (check availability)
5. Find and re-engage stale deals (14+ days)
6. Research new company before first call
7. Update deal after successful demo
8. Create pipeline report for weekly standup
9. Handle "not interested" response gracefully
10. Multi-thread a deal (add champion + economic buyer)
11. Log meeting notes and create follow-up tasks
12. Compare two deals to prioritize outreach
13. Draft proposal email with pricing
14. Nurture sequence for early-stage lead
15. End-of-quarter pipeline cleanup
