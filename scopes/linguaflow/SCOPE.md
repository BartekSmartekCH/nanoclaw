# LinguaFlow — Personalized Language Tutorial App

## Scope Document

---

## App Concept & Vision

LinguaFlow is a personalized, adaptive language learning application that combines proven pedagogical methodologies with modern AI-driven personalization. Unlike gamified flashcard apps, LinguaFlow is designed to feel like a personal tutor — adapting to each learner's native language, proficiency level, goals, and error patterns to deliver genuinely effective language instruction.

**Core Principle:** The app should feel like a tutor, not a test. Feedback is encouraging, specific, and educational — even when correcting errors.

**Founding Pedagogical Pillars:**
- Comprehensible Input (Krashen's i+1) as the foundation for all content delivery
- Spaced Repetition (FSRS) for long-term retention
- Task-Based Language Teaching (TBLT) for real-world skill application
- Scaffolded production (recognition -> guided production -> free production)
- Native language (L1) awareness as a core differentiator

---

## Key Features

### Adaptive Learning Engine
- **Bayesian Knowledge Tracing (BKT):** Every concept (word, grammar rule, pronunciation pattern) is modeled as a node in a learner knowledge graph with a mastery probability, updated after every interaction.
- **FSRS (Free Spaced Repetition Scheduler):** Reviews items in context (example sentences, mini-dialogues) rather than isolated flashcards. More accurate than SM-2.
- **i+1 Content Selection:** The engine selects content that is ~90-95% comprehensible to the learner, with just enough new material to stretch them.
- **Error Pattern Detection:** Distinguishes between mistakes (slips — the learner knows the rule) and errors (systematic knowledge gaps). Only errors trigger targeted remediation exercises.

### L1 Interference-Aware Personalization
- An **L1 interference matrix** per language pair identifies predictable challenges based on the learner's native language.
- Example: Mandarin speakers learning English receive extra practice on articles (a/the) since Mandarin has no article system; Spanish speakers learning French get accelerated paths through shared vocabulary but focused work on false cognates.
- Content is tagged with relevant L1 interference patterns, enabling the adaptive engine to surface targeted exercises.

### Present-Practice-Produce (PPP) Learning Loop
Each lesson follows a scaffolded sequence:
1. **Present:** New material introduced via comprehensible input (dialogues, short texts, audio)
2. **Practice:** Guided exercises with increasing difficulty — recognition (multiple choice), then guided production (cloze/fill-in-blank, sentence reordering, word bank construction)
3. **Produce:** Freer production tasks (typing responses, structured speaking, task-based challenges like "order food at a restaurant")
4. **Review:** FSRS-scheduled review of previously learned material, always in context

### Thematic + Spiral Curriculum
- Content organized into **thematic units** (e.g., "Food & Dining," "At the Airport," "Daily Routine") for real-world relevance and motivation.
- **Spiral curriculum (Bruner):** Grammar structures and vocabulary recur across multiple themes at increasing complexity. Example: present tense of "to be" appears in Greetings (Theme 1), reappears in Travel (Theme 5), and is effortless by Storytelling (Theme 12).
- **Recurring narrative characters** across units create emotional investment and provide natural context for language use.
- Each unit contains 5-8 lessons, each ~10-15 minutes, mixing vocabulary, grammar, and skills practice.

### Computer-Adaptive Placement Testing (CAT)
- Uses **Item Response Theory (IRT)** for question calibration.
- 15-20 adaptive questions covering vocabulary breadth, grammar recognition, and reading comprehension.
- Places learners across CEFR levels (A1-C2).
- Supplemented by self-report questions (native language, prior study, goals).
- Ongoing calibration via continuous implicit assessment and periodic checkpoint tests (every 2-4 weeks).

### Skill Balance System
- Default distribution: 30% reading, 25% listening, 25% speaking, 20% writing.
- Adjustable by learner goals (conversation, travel, academic, business) shifting balance by 10-15%.
- At beginner levels (A1-A2), receptive skills (reading/listening) are weighted more heavily; at B1+, productive skills (speaking/writing) increase.
- System detects weak/avoided skills and gently nudges learners toward them with appropriately easy exercises.

### Error-Tolerant Input
- **Fuzzy matching (Levenshtein distance)** for typo tolerance at beginner levels.
- Accent mark omissions are flagged as informational at A1-A2, scored at B1+.
- Feedback tone is always constructive: "Almost! You used [X], but in this context we'd say [Y] because [reason]" rather than "Wrong!"

### Cultural Micro-Lessons
- Brief (2-3 sentence) cultural notes embedded within relevant lessons.
- Tagged by CEFR level and theme.
- Examples: "In France, you greet shopkeepers when entering a store" alongside greeting vocabulary.

### Gamification
- **Streaks:** Daily practice tracking with streak freezes.
- **XP System:** Points earned per exercise, weighted by difficulty and skill type.
- **Levels:** Progression milestones tied to actual CEFR progress, not just XP accumulation.

### Adaptive Daily Micro-Learning
- Push notifications with personalized content: words/phrases the learner is about to forget (FSRS-scheduled) or previews of upcoming lesson material.
- Keeps the target language present even on days without a full lesson.

---

## Tech Stack Recommendations

### Frontend
- **React Native** (cross-platform iOS/Android) with **Expo** for rapid development
- **React** (web version) sharing core component logic
- **TypeScript** throughout for type safety

### Backend
- **Node.js** (Express or Fastify) for the API layer
- **Python** microservice for the adaptive learning engine (BKT, FSRS, knowledge graph algorithms) — Python's ML/data ecosystem is superior for this
- **PostgreSQL** as the primary database (relational data: users, progress, content metadata)
- **Redis** for session caching, streak tracking, and real-time learner state

### AI / ML Services
- **FSRS** (open-source) for spaced repetition scheduling
- **Whisper API** (OpenAI) for speech-to-text in speaking exercises
- **LLM API** (Claude or GPT) for writing feedback (Phase 2) and AI conversation partner (Phase 2)

### Content & Media
- **Structured content DB** in PostgreSQL with a CMS layer for content creators
- **Audio storage** (S3 or equivalent) for native speaker recordings
- **Content tagging schema:** theme, CEFR level, grammar concepts, vocabulary sets, L1 interference patterns, skill type

### Infrastructure
- **Docker** + container orchestration for deployment
- **CI/CD** pipeline (GitHub Actions)
- **CDN** for media delivery
- **Analytics pipeline** for learning data (anonymized) to improve the adaptive engine over time

---

## User Experience Flow

### Onboarding (First Session)
1. **Welcome & Language Selection** — Choose target language and confirm native language
2. **Goal Setting** — Select primary goal (conversation, travel, business, academic, general)
3. **Session Preference** — Preferred daily study time (5, 15, or 30 minutes)
4. **Adaptive Placement Test** — 15-20 question CAT covering vocabulary, grammar, reading comprehension
5. **Personalized Learning Path** — Results displayed with CEFR level, recommended starting unit, and a preview of the first lesson

### Core Learning Session
1. **Dashboard** — Today's lesson, SRS review queue, streak status, XP progress
2. **Lesson Flow:**
   - Short dialogue or text (comprehensible input with audio)
   - Vocabulary highlight and practice (in-context, not isolated)
   - Grammar pattern recognition exercises
   - Scaffolded production (cloze -> reordering -> guided writing/speaking)
   - Task-based challenge ("Use what you learned: order a coffee")
   - Cultural micro-lesson (when relevant)
3. **SRS Review** — Mixed review of items from previous lessons, always in context (sentences, not isolated words)
4. **Session Summary** — XP earned, words practiced, accuracy, streak update

### Between Sessions
- Adaptive push notification with a micro-learning moment (word about to be forgotten, preview of next lesson)
- Quick-access review mode for 2-3 minute sessions

### Periodic Assessment
- Checkpoint tests every 2-4 weeks (5-10 minutes)
- CEFR milestone assessments when approaching a new level (celebratory framing)

---

## Personalization Approach

### Dimensions (Ranked by Impact)

| Priority | Dimension | How It's Used |
|----------|-----------|---------------|
| 1 | Current proficiency (CEFR level per skill) | Drives content difficulty selection via BKT mastery probabilities |
| 2 | Native language (L1) | L1 interference matrix surfaces targeted exercises for predicted challenge areas |
| 3 | Learning goals | Shifts skill distribution and vocabulary domain emphasis |
| 4 | Error patterns | Systematic errors trigger targeted remediation sequences |
| 5 | Learning pace / available time | Session length and lesson density adapt to preference |
| 6 | Preferred modalities | Emerges from behavioral data (skip rates, performance by exercise type) |

### Learner Model Architecture
- **Knowledge Graph:** Nodes = concepts (words, grammar rules, pronunciation patterns). Edges = prerequisite relationships and thematic associations.
- **Mastery Probability:** Each node has a per-learner mastery probability (0.0-1.0), updated via BKT after every interaction. Inputs: correctness, response latency, hint usage.
- **FSRS Scheduling:** Each reviewed item has FSRS parameters (stability, difficulty, due date) determining optimal review timing.
- **Error Pattern Tracker:** Tracks systematic errors by category (e.g., "verb conjugation — past tense," "adjective-noun order") and triggers remediation when frequency exceeds threshold.
- **L1 Interference Layer:** Pre-loaded data per language pair identifying high-probability challenge areas, used to weight content selection.

---

## Milestones & Phases

### Phase 1 — MVP
**Goal:** Deliver a functional, pedagogically sound adaptive learning app for 1-2 language pairs.

| Feature | Details |
|---------|---------|
| Core PPP learning loop | Scaffolded lessons: present (input) -> practice (guided exercises) -> produce (structured output) |
| Adaptive engine | BKT learner model, FSRS review scheduling, error pattern tracking (mistake vs. error distinction) |
| CAT placement | IRT-calibrated adaptive test, CEFR placement (A1-C2) |
| Content | 2 language pairs (English-Spanish, Spanish-English), thematic units with spiral curriculum |
| L1 interference | Curated interference matrix for EN-ES/ES-EN, integrated into content selection |
| Exercise types | Multiple choice, cloze, sentence reordering, word bank construction, guided sentence writing, listen-and-repeat |
| Basic pronunciation | Whisper STT compared against expected text (match/no-match scoring) |
| Cultural micro-lessons | Brief text-based cultural notes embedded in relevant lessons |
| Gamification | Streaks, XP, level progression |
| Daily micro-learning | Adaptive push notifications (FSRS-driven word review or lesson previews) |
| Error-tolerant input | Fuzzy matching for typos, constructive feedback tone |
| Platforms | iOS, Android (React Native), Web (React) |

### Phase 2 — Enhanced Skills & AI Features
**Goal:** Add productive skills depth, AI-powered features, and expand language coverage.

| Feature | Details |
|---------|---------|
| Structured speaking | Pronunciation scoring with phoneme-level analysis, shadowing exercises |
| Free writing + LLM feedback | Open-ended writing tasks with AI-powered grammar/style feedback |
| AI conversation partner | LLM-based chat tutor with level-appropriate language constraints |
| Pronunciation module | Waveform comparison, mouth position diagrams, phoneme-level feedback |
| Learner analytics dashboard | Progress visualization: words learned, accuracy trends, CEFR progress, skill balance |
| Study buddy (lightweight) | Asynchronous peer exchanges ("Send a sentence using today's vocab to your partner") |
| Additional languages | French, German, Japanese, Portuguese (with corresponding L1 interference matrices) |
| Advanced gamification | Achievements, leaderboards, weekly challenges |

### Phase 3 — Community & Advanced Personalization
**Goal:** Build social features, integrate authentic content, and deepen adaptive intelligence.

| Feature | Details |
|---------|---------|
| Social/community platform | Practice groups, community challenges, peer corrections |
| Authentic content | Simplified news articles, song lyrics, social media posts, video clips (B1+) |
| User-generated content | Community-submitted exercises and content |
| Advanced adaptation | Learning style detection from behavioral data, optimal session timing suggestions |
| Certification system | Formal assessments aligned with CEFR standards, shareable credentials |

---

## Summary

LinguaFlow differentiates itself through three core principles:

1. **Pedagogically grounded:** Every feature is rooted in established language teaching methodology (Krashen, TBLT, PPP, spiral curriculum) rather than pure gamification.
2. **L1-aware personalization:** Native language interference patterns drive content selection, making practice targeted and efficient.
3. **Tutor, not test:** Feedback is encouraging, explanatory, and constructive. The app teaches even when correcting.

The MVP (Phase 1) delivers genuine learning value from day one with a complete adaptive learning loop, not just flashcards with points.
