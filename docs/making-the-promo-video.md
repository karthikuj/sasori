# Making the launch promo video

The 2.0.0 launch promo is a short motion-graphics film: a 16:9 cut (1920×1080,
about 40 s) and a 9:16 cut (1080×1920, about 27 s), each with and without
music. It is code, not a timeline in a video editor: a
[Remotion](https://www.remotion.dev/) project renders every frame from React
components, the real crawl data and real screenshots. This page explains how it
was made and how to make it again for a later version.

## Where the project is kept

The project and its renders are **not in this repository**. They are about
75 MB of video, audio and images, and they are archived outside the repo, in
the maintainer's Drive, as a folder named `promo`.

To work on it, copy that folder back into a checkout of this repo at
`resources/promo/`. `capture/capture.mjs` finds Puppeteer through a relative
path into the repo's own `node_modules`, so it only works from that location.
Do not commit the folder. `resources/promo/` is not in `.gitignore`, so take
care with `git add`, or add the path to `.git/info/exclude` while you work.

Inside `promo/`:

| Path | What it is |
|---|---|
| `design-spec.md` | The brief, the data and safety rules, the visual direction, the shot list, the beat grid and both storyboards. **Read this first.** §6a lists every change made during production. |
| `styleframes/` | Still frames that fixed the look before anything moved. |
| `analysis/` | The beat analysis of the music (Python + librosa) and its output. |
| `inputs/` | The real crawl artifacts the data shots are built from: `output-graph.dot`/`.mmd` (from `--crawl-graph`) and `output-inventory.json` (from `--inventory`). |
| `video/` | The Remotion project. |
| `video/src/timeline.ts` | The timeline of both cuts, written in beats. |
| `video/src/shots/`, `video/src/stations/` | One component per shot. Stations are the feature shots in the middle of the film. |
| `video/src/data/` | JSON generated from `inputs/` and the startup banner. |
| `video/public/` | Screenshots (`textures/`), the logo and wordmark (`brand/`), the music and sound effects (`audio/`). |
| `video/capture/` | Scripts that took the screenshots and built `src/data/`. |
| `video/out/` | The four final renders, `sasori-promo-*.mp4`. |

## How it was made

The film was made in one Claude Code session in November 2026, using the
**video-shotcraft** skill
([repository](https://github.com/Vincentwei1021/video-shotcraft),
[shot gallery](https://vincentwei1021.github.io/video-shotcraft/library.html)).
The skill is a library of shot recipe cards, each with a tuned Remotion
implementation, plus a production workflow and a set of royalty-free music and
sound effects. Install it as a Claude Code plugin before you start.

The skill has three modes: fill in its ready-made Ink Press template, let the
agent decide everything, or **co-creation**. This film used co-creation: the
agent proposes and you approve at each stage before anything is built. Ink Press
was ruled out because it is built around screenshots of a web app, and Sasori
is a command-line tool.

You do not need the skill to re-render or change this film. You need it for a
new one, because it carries the shot recipes the stations were adapted from.

### The materials

The prompt was given together with a `resources/promo-kit/` folder. It was
deleted after the film was made, so collect these again for the next version:

| File | Where it came from | What the film used it for |
|---|---|---|
| `README.md`, `CHANGELOG.md` | Copies of the repo's own | The only source of facts and captions |
| `sasori-mark.svg`, `sasori-mark-1024.png` | `resources/brand/` | The scorpion mark in the outro |
| The wordmarks and `banner.js` | `resources/brand/` | The outro wordmark, and the colour startup banner in the terminal shots |
| `sasori.gif` | `resources/sasori.gif`, the README's demo | The real log lines in the terminal shots |
| `demo.mp4` | A screen recording of a four-window crawl | One frame of it, taskbar cropped, became the workers shot |
| `recorder.png` | `resources/recorder.png` | The login shot |
| `output-graph.dot`, `output-graph.mmd` | `--crawl-graph` on a crawl of `security-crawl-maze.app` | The crawl graph the whole film flies through |
| `output-inventory.json` | `--inventory` on the same crawl | The numbers in the coverage shot: 173 endpoints, 60 states, 269 requests |
| `create-recording.gif`, `devtools-options.png`, `export-recording.png` | `resources/` | Not used: the login shot was kept to `recorder.png` |
| `prompt.txt` | Written for the session | The prompt below |

The agent also took fresh screenshots of `security-crawl-maze.app` pages for the
problem shot. The music, `bgm-tech-house.mp3`, and all the sound effects come
from the skill's own set.

### The prompt

This is the prompt as it was given, unchanged. For the next version, update the
version number, the feature list and anything the README no longer says.

```text
Use video-shotcraft to make a launch promo for my open-source project, OWASP Sasori.
Use the co-creation mode: confirm the product brief, visual direction, shot mapping
and final storyboard with me before you build anything. Don't use the Ink Press
template; Sasori is a command-line tool, not a web app, so it doesn't fit.

## The product
Sasori is a dynamic web crawler for security testing. It drives a real Chromium
browser through a web application, logs in, clicks through it, fills its forms,
and reports every endpoint it reaches, so a proxy or scanner such as ZAP or Burp
can test them. It is an OWASP Incubator project, MIT licensed, written in
TypeScript. Version 2.0.0 is the launch we are announcing.

Repository: https://github.com/karthikuj/sasori
OWASP page: https://owasp.org/projects/sasori
Install: npm install -g sasori-crawl   (needs Node.js 22.12+)

## The story (use as the spine; improve the wording)
1. Hook: a scanner can only test what it can reach.
2. Problem: a crawler that only reads HTML misses most of a modern web app:
   menus that open with JavaScript, forms that submit in the background, screens
   that never change the URL, and everything behind a login.
3. Answer: Sasori uses a real browser, so it sees those screens and the
   requests they make.
4. Features, one per shot, no more than 5 or 6:
   - Logs in with a Chrome DevTools Recorder recording (or HTTP Basic auth),
     checks the session is still alive, and logs in again when it expires.
   - Runs several workers as windows of one browser that share one login.
   - Maps the app as a graph of page states, explores each screen once, and
     replays only the clicks it needs to get back.
   - Stays in scope with include/exclude rules; can seed from robots.txt and
     sitemaps.
   - Routes all traffic through an intercepting proxy (ZAP, Burp), with
     custom CA trust.
   - Writes an endpoint inventory and a crawl graph, so coverage can be measured.
   - Runs from the command line, or as a REST API that runs many scans at once.
5. Outro: the OWASP Sasori wordmark, "v2.0.0", the npm install line and the
   GitHub URL, held on screen for at least 2 seconds.

## Format
- 16:9, 1920×1080, about 30–40 seconds. After the main film, also give me a
  9:16 cut of about 20–30 seconds for LinkedIn/X/Shorts.
- Music: a confident, driving electronic track from your BGM set, with the cuts
  on the beat. Deliver with-BGM and without-BGM versions.
- Tone: technical, precise and a little dramatic, like a security tool launch,
  not a consumer app ad. Short on-screen captions, no voiceover.

## Visual identity (take it from the assets, not a generic "hacker" look)
- Logo and wordmarks: the attached files from resources/brand/. The mark is a
  scorpion tail shaped like an S ("sasori" is Japanese for scorpion). Use the
  tail-strike as a motion idea if it fits, but keep it tasteful.
- Palette from the logo: #2b2741 (deep background), #5d5294, #796cbf, #968ae0,
  #b5abfc (accent), #e7e5fe (light text). Dark backgrounds.
- Real product visuals only: the terminal recording, the crawl output, the
  crawl-graph diagram and the screenshots I attached. Don't invent UI for
  Sasori; it has no GUI. Terminal shots should look like a real terminal
  (monospace, the real log lines), not a fake Matrix effect.
- No green-on-black hacker clichés, skulls, hoodies or padlocks.

## Shots I'm interested in (check names against the Gallery; suggest better ones)

1. basic-3d-scene
2. collab-cursor-moves
3. type-and-filter


## Hard rules
- Only use facts in this prompt or the attached README. No made-up numbers,
  benchmarks, user counts, star counts or quotes.
- Show only the demo target security-crawl-maze.app and the attached material.
  No real usernames, home paths, hostnames, tokens or private systems.
- Use the name "OWASP Sasori", but not the OWASP logo itself.

Feel free to use anything from the promo-kit directory given to you
```

The three suggested shots came from browsing the shot gallery. Pick yours the
same way: copy a card's name from the gallery into the prompt.

### What happened after the prompt

The agent first read the README and the materials, then stopped at each
approval point. Your part was these replies, in order:

1. **Product brief.** The agent wrote up the brief, the facts it would use and
   what it would leave out, plus a few open questions. Reply: *"don't crop or
   mask the Made by @5up3r541y4n line, everything else is fine"*. Accepting the
   rest settled three things: "CLI or REST API" went into the outro rather than
   getting its own shot, the real inventory numbers were shown labelled as a
   demo crawl, and the login shot used only `recorder.png`, with no footage of
   a real login site.
2. **Visual direction.** The agent offered directions with styleframes and
   recommended "B, The Crawl Graph", using direction A's terminal look. Reply:
   *"your recommendation is good, go ahead"*.
3. **Shot mapping.** One gallery card per beat of the story, each with a
   backup. Reply: *"Approve, map shots"*.
4. **Storyboard.** Both cuts beat by beat, with picture, caption and sound for
   each shot. Reply: *"Approve, storyboard"*.
5. **Build.** Reply: *"Approve, build it"*. From there the agent captured
   screenshots, analysed the music, built and rendered both cuts, had a
   separate reviewer check them, fixed what the review found and delivered the
   four files.

The approved shot mapping (`design-spec.md` §4 has the backups):

| Part of the story | Gallery card |
|---|---|
| The whole film's camera | `basic-3d-scene`: each feature is a station in the graph's space, and the camera flies between them |
| Hook | `tension-camera-moves · slow-push-in` |
| Problem | `quad-split-parallel-scenes` |
| Answer | `typewriter-moves · terminal-typewriter` |
| Login | `fui-hud-moves · reticle-lock-on` |
| Workers | `collab-cursor-moves · cast-ensemble` |
| Graph | `glow-flyline-moves · flyline-arc` |
| Scope | `type-and-filter` |
| Proxy | `bezier-source-converge-merge` |
| Coverage | `odometer-digit-roll` |
| Outro | `logo-shrink-wordmark-lockup`, with the S mark in place of the ring |

The 9:16 cut keeps four of the features: the terminal, workers, scope and
coverage.

## Rules the film follows

These came from the brief and are worth keeping for any later version
(`design-spec.md` §2 has the full list):

- **Only real facts.** Every claim comes from the README. Every number on screen
  comes from a real crawl. No invented benchmarks, user counts, star counts or
  quotes. The coverage numbers are labelled as a demo crawl.
- **Only the demo target.** The only site shown is `security-crawl-maze.app`. No
  real usernames, home paths, hostnames, tokens or private systems. The one
  login visual is `resources/recorder.png`.
- **Real product visuals, no invented Sasori UI.** The terminal is the real
  banner and the real log lines; the graph is the real crawl graph.
- **The name "OWASP Sasori", never the OWASP logo.** Sasori's own mark and
  wordmark are fine.
- **Palette from the brand assets** (#2b2741, #5d5294, #796cbf, #968ae0,
  #b5abfc, #e7e5fe) on dark backgrounds. No green-on-black hacker look, skulls,
  hoodies or padlocks.
- The banner line "Made by @5up3r541y4n 🔥" is shown uncropped.

## Re-rendering the current film

You need Node 22.12 or later. Remotion downloads its own browser and bundles its
own ffmpeg.

```bash
cd resources/promo/video
npm ci
npx remotion studio src/index.ts          # preview and scrub in the browser
```

Render the four finals:

```bash
npx remotion render src/index.ts SasoriPromo         out/sasori-promo-16x9.mp4       --crf=16
npx remotion render src/index.ts SasoriPromo         out/sasori-promo-16x9-nobgm.mp4 --crf=16 --props=props-nobgm.json
npx remotion render src/index.ts SasoriPromoVertical out/sasori-promo-9x16.mp4       --crf=16
npx remotion render src/index.ts SasoriPromoVertical out/sasori-promo-9x16-nobgm.mp4 --crf=16 --props=props-nobgm.json
```

`props-nobgm.json` (`{"bgm":false}`) turns the music off and keeps the sound
effects, so someone can lay their own music under the film. `--crf=16` matters:
the default quality bands the dark gradients visibly.

Rendering is deterministic. There is no `Math.random()` or `Date.now()`, and
every pseudo-random value comes from a fixed seed, so the same code renders the
same frames.

## Making it for a new version

Most of the film describes what Sasori does, so a new version mostly means a new
version string and fresh data. In order:

1. **Update the version text.** `v2.0.0` is written in
   `src/shots/Outro.tsx` (the pill under the wordmark), `src/stations/Term.tsx`
   (the caption eyebrow) and `src/workbench.ts`. Search `src/` for the old
   version to catch any others.

2. **Refresh the banner.** The terminal shows the real banner from
   `resources/brand/banner.js` (24-bit ANSI). It is stored as HTML in
   `src/data/graph-raw.json` (`bannerHtml`) and turned into `src/data/banner.json`
   by `prep-data.mjs`. Render the new banner's ANSI to the same
   `<span style="color:rgb(r,g,b)">` form, put it in `bannerHtml`, and run step 4.

3. **Run a fresh crawl** of `security-crawl-maze.app` with the new build and
   save its artifacts into `inputs/`:

   ```bash
   node dist/bin/index.js start --config <crawl-maze config> \
       --inventory resources/promo/inputs/output-inventory.json \
       --crawl-graph resources/promo/inputs/output-graph.json
   ```

   The coverage station's numbers (endpoints, states, requests) come from the
   inventory's `stats`. The graph station draws `graph-raw.json`, which is the
   crawl graph with a radial layout already applied. It was generated once from
   `output-graph.dot` and no script in the folder rebuilds it. For a new graph,
   lay the nodes out again. Each node needs `x`, `y` and its depth `d`, and the
   edges keep `from`, `to` and `label`. Then run step 4.

4. **Rebuild the data JSON** from `video/`:

   ```bash
   node capture/prep-data.mjs
   ```

5. **Re-take screenshots only if the pages changed.** `capture/capture.mjs`
   takes the problem-shot screenshots of `security-crawl-maze.app` at 2x with
   the Puppeteer in the repo's own `node_modules` (run `npm ci` at the repo root
   first). `textures/workers-4win.png` is a frame of the four-window demo
   recording. Crop out the desktop taskbar, and anything else outside the
   browser windows.

6. **Check every number and claim against the new README.** If a feature
   changed, change its station and its caption. If a new feature should be in
   the film, it needs a new station, and the timeline has to make room for it
   (see below).

7. **Render and look at it.** Extract stills at the key frames and check them
   before you call it done:
   `npx remotion still src/index.ts SasoriPromo out/qa/f-600.png --frame=600`.
   Have someone who did not build it watch the whole film against
   `design-spec.md`: they catch what the maker no longer sees.

8. **Archive it again.** Put the updated folder back in Drive, renders
   included, and remove it from the checkout.

## How the timing works

The film is cut to the music. `analysis/` fitted a beat grid to the kick drum of
`bgm-tech-house.mp3`: 124 BPM, beat 0 at 0.016 s, one beat every 0.48387 s. The
fit matched 96.8% of the kicks with a mean error of 6.1 ms.

`src/timeline.ts` writes every shot as a range of beats, not frames. `makeBeatF`
turns a beat into a frame, and each cut starts the music at a different beat:
beat 8 for 16:9 and beat 20 for 9:16. The station lengths are therefore fixed in
beats (7 beats each in 16:9). To add or remove a station, change the `PLAN` for
that cut and the other stations shift with it. The outro must stay last and hold
its install line and URL for at least 2 s.

Only two hits shake the whole frame, both on strong beats: the drop at beat 32,
when Enter is pressed, and the logo collapse in the outro. Keep it to three at
most, or the hits stop meaning anything. Every other beat only moves elements
inside a shot.

Sound effects are placed in `src/audio.ts`. Each one is positioned by when its
peak lands, not when the file starts, so the table stores each file's peak
delay. The output also has a measured audio delay of one frame
(`OUTPUT_AUDIO_OFFSET_SEC`), which the table corrects for.

If you change the music, rerun the analysis
(`python analysis/beats.py <file>`, then `analysis/grid2.py <file>`), put the new
BPM and beat 0 into `timeline.ts`, and recheck where the drop falls
(`analysis/song_structure.py` prints the loudness per bar).

## Lessons from making this one

- **Text must be readable on a phone.** Captions are at least 56 px tall and
  supporting text at least 32 px. The first render missed this and the review
  caught it, worst in the 9:16 cut.
- **Hold the key moment.** Labels, the 403 stamp and the config cards first went
  past too fast to read. Each now stays still long enough to read after it
  settles (the 403 stamp, for example, holds about 22 frames).
- **Check what a claim implies.** The proxy headline first said "every request
  goes through your proxy", but session checks are sent straight from Node and
  do not pass through it. The headline now says "every crawled request".
- **Third-party logos creep in through screenshots.** One `security-crawl-maze`
  page carried a framework logo and was dropped.
- **The 16:9 cut runs 40.6 s,** slightly over the 40 s target, because the outro
  needed its full 2 s hold.
