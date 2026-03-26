# Personal Productivity Agent — Domain Spec

## Overview

An autonomous personal assistant that manages daily productivity — scheduling,
email triage, task management, research, and daily briefings. Acts as a chief
of staff who keeps everything organized so you can focus on what matters.

## Integrations

| Service | Purpose | Auth |
|---------|---------|------|
| Google Calendar / Outlook | Scheduling, availability, meetings | OAuth |
| Gmail / Outlook | Email — triage, draft, send, search | OAuth |
| Todoist / Notion | Task management, projects, notes | API key |
| Web Search | Research, fact-checking, current info | API key |
| Slack | Team communication, status updates | Bot token |

## Goal Types

### 1. Schedule Meeting
- **Trigger:** User request or follow-up needed
- **Flow:** Check calendar → Find availability → Match with attendees → Create event → Send invites
- **Success criteria:** Meeting scheduled with all parties confirmed
- **Max steps:** 5

### 2. Triage Inbox
- **Trigger:** Morning routine or on-demand
- **Flow:** Scan inbox → Categorize (urgent/action/FYI/archive) → Summarize top items → Create tasks from action items
- **Success criteria:** Inbox triaged with summary and action items extracted
- **Max steps:** 6

### 3. Manage Tasks
- **Trigger:** User request or daily review
- **Flow:** Get tasks → Prioritize → Create daily plan → Set reminders → Track completion
- **Success criteria:** Prioritized plan created with time blocks
- **Max steps:** 5

### 4. Research Topic
- **Trigger:** User request
- **Flow:** Search for information → Gather sources → Synthesize findings → Create summary
- **Success criteria:** Concise summary with sources provided
- **Max steps:** 6

### 5. Daily Briefing
- **Trigger:** Morning routine (scheduled or on-demand)
- **Flow:** Check calendar → Triage inbox → Review tasks → Check reminders → Generate briefing
- **Success criteria:** Comprehensive daily overview delivered
- **Max steps:** 8

### 6. Draft Communication
- **Trigger:** User request
- **Flow:** Understand context → Search relevant notes/emails → Draft message → Review
- **Success criteria:** Draft ready for review or send
- **Max steps:** 5

## Tool Registry

### Calendar
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| check_calendar | check_calendar | Check calendar availability for a date range | Returns free/busy slots |
| schedule_event | schedule_event | Create calendar event with attendees and details | Event created, invites sent |
| get_agenda | get_agenda | Get today's or specific day's full agenda | Returns scheduled events |
| reschedule_event | reschedule_event | Move an existing event to a new time | Event moved, attendees notified |
| cancel_event | cancel_event | Cancel a calendar event | Event cancelled, attendees notified |

### Email
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| triage_inbox | triage_inbox | Scan and categorize inbox by priority and action needed | Returns categorized email list |
| get_email | get_email | Get full email content and thread | Returns email details |
| draft_email | draft_email | Draft an email based on context | Draft created |
| send_email | send_email | Send an email | Email delivered |
| search_emails | search_emails | Search email by sender, subject, date, keyword | Returns matching emails |
| archive_emails | archive_emails | Archive processed emails | Emails archived |

### Tasks
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| get_tasks | get_tasks | Get task list with priorities, due dates, projects | Returns task list |
| create_task | create_task | Create a new task with priority and due date | Task created |
| complete_task | complete_task | Mark a task as complete | Task status updated |
| update_task | update_task | Update task priority, due date, or description | Task updated |
| get_projects | get_projects | Get project list with progress | Returns projects |

### Notes & Knowledge
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| search_notes | search_notes | Search notes and documents by topic | Returns matching notes |
| create_note | create_note | Create a new note or document | Note created |
| get_note | get_note | Get full note content | Returns note |

### Research
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| web_search | web_search | Search the web for current information | Returns search results |
| summarize_url | summarize_url | Fetch and summarize a web page | Returns page summary |

### Reminders & Communication
| Tool | Action Type | Description | Effects |
|------|-------------|-------------|---------|
| set_reminder | set_reminder | Set a reminder for a specific time | Reminder created |
| draft_summary | draft_summary | Generate a structured summary from context | Summary text generated |
| send_slack | send_slack | Post message to Slack | Message posted |

## Decision Rules

### Email Priority
- **Urgent:** From boss, mentions deadline today, contains "urgent"/"ASAP", calendar conflicts
- **Action needed:** Requires a reply, contains a question, meeting invite, approval request
- **FYI:** Status updates, newsletters, automated notifications
- **Archive:** Marketing, spam-like, old threads with no action

### Task Prioritization (Eisenhower Matrix)
- **Do first:** Urgent + Important (deadlines, critical blockers)
- **Schedule:** Important + Not urgent (deep work, planning, relationships)
- **Delegate:** Urgent + Not important (interrupts, minor requests)
- **Drop:** Not urgent + Not important (low-value busywork)

### Meeting Scheduling Rules
- Protect focus blocks (no meetings during marked focus time)
- Prefer afternoon for meetings, morning for deep work
- Minimum 15-minute buffer between meetings
- Default meeting length: 30 minutes (don't accept 1-hour unless justified)
- Include agenda in every meeting invite

### Daily Briefing Contents
1. Today's calendar (meetings, deadlines)
2. Top 3 urgent emails
3. Top 3 priority tasks
4. Reminders due today
5. Blockers or conflicts to resolve

## Probe Training Domains

```yaml
training_domains:
  - personal_assistant
  - email_management
  - scheduling
  - task_management
  - research_synthesis
```

## Test Scenarios (15)

1. Schedule a meeting (check availability, create event)
2. Morning inbox triage (categorize 20 emails, extract actions)
3. Create daily plan from tasks and calendar
4. Draft and send follow-up email
5. Research a topic and create summary
6. Reschedule conflicting meetings
7. Daily briefing generation
8. Create tasks from email action items
9. Find and summarize meeting notes
10. Prepare for upcoming meeting (gather context)
11. Handle double-booked calendar
12. Weekend planning (personal tasks + prep for Monday)
13. Delegate tasks with clear instructions
14. Search across notes, email, and calendar for topic
15. End-of-week review (what was done, what carries over)
