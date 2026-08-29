# Hope design

This document defines Hope's project-wide GUI guidance and the visual contracts
of the current Align, Diff, and Commit Diff HTML artifacts.

The Project GUI layout and Project GUI controls sections apply whenever a Hope
feature introduces or changes a matching layout, control, or interaction.

Feature-named sections apply only to that artifact. Sections named for Hope
artifacts apply to both.

The Align, Diff, and Commit Diff Skills own their feature judgment and prose.

Align defines the shared artifact visual baseline. Diff matches that baseline
for common color, type, spacing, product-bar, document, and navigation roles.
Each feature still owns its visual tokens and renderer, and neither imports the
other at runtime.

Do not introduce a shared artifact framework until two real consumers need the
same invariant.

## Project GUI layout

Show each piece of information once in a viewport. A responsive layout may move
it, but must not leave a second visible copy.

Define spacing and alignment through layout groups. Do not correct one element
with an isolated margin when the relationship belongs to the group.

Derive the position of a connecting line, arrow, or other annotation from the
same layout structure as the element it identifies. Do not maintain
independent hand-tuned coordinates.

When space becomes too narrow, move needed information and actions into a
compact form that preserves access. Do not merely hide or squeeze them.

Keep body prose in one reading column. On a wide screen, use parallel columns
only for a short comparison summary whose options are easier to scan together.
Limit each comparison cell to a title, visual when useful, brief summary, and
brief points on the same comparison axes; put longer supporting explanation
below in the single reading flow. Stack comparison cells when the viewport is
narrow. Navigation, labels, tables, diagrams, and controls are structural UI
rather than prose columns and follow the structure they need.

Preserve an authored semantic paragraph as a separate HTML paragraph. Do not
collapse distinct paragraphs into one run of text or use layout columns to
create paragraph boundaries.

Use the same small set of semantic section patterns across Align, Diff, and
Commit Diff:

- structured label-and-value rows for summaries, with the goal first;
- parallel cells only for brief comparisons that must be scanned together;
- one ordered vertical sequence for behavior or process; and
- visible conclusions with native disclosures for reasons, verification, and
  supporting evidence.

Keep these visual roles consistent without making either renderer import the
other feature.

Keep summary labels compact without changing their wording. In Korean, when a
summary label consists of two two-syllable words, stack one word per line in
the label gutter while preserving the space in its text and accessible name.

## Diff artifact direction

The Diff artifact should feel:

- direct;
- compact;
- calm;
- easy to scan; and
- clearly divided without looking boxed in.

Use familiar words, short sentences, and one clear reading path.

Prefer useful content over decoration.

Use the current Align artifact as the primary reference for common visual
roles.

The Diff feature's `scripts/design/tokens.mjs` is the code source of truth for
its values. Common roles match the corresponding Align values without importing
Align code. Diff-only code and status roles remain local to Diff.

The Diff renderer must read those tokens instead of copying their values.

Commit Diff follows the same artifact direction and semantic structure. It
replaces pull-request identity with one reviewed local Git commit and its
selected parent. Its renderer and tokens stay inside the Commit Diff Skill and
do not import Diff at runtime.

## Diff artifact structure

The first screen should explain the shape and limits of the change in about 30
seconds.

Show a plain-language title written from the changed behavior, reviewed commit,
goal, previous and new behavior, practical impact, the top one to three review
items or a clear empty result, and material review limits. Keep the provider's
pull-request title in the collapsed review information instead of using it as
the document title. Let the title name one decisive result; keep secondary
mechanics in the summary when they make the title harder to scan.

Compare the brief previous and new behavior summaries side by side on a wide
screen and stack them in that order on a narrow screen. Keep the practical
impact and every longer explanation in the single reading flow below the
comparison.

Keep internal source IDs, model details, token counts, processing state, and
capture time out of the first screen.

Do not repeat repository identity in multiple prominent places.

Use four top-level reading areas and omit a conditional area when it adds no
value:

1. Summary
2. Behavior change
3. Review items
4. Evidence and scope

Place the unnumbered document title first. Start the numbered reading areas
below it with a visible `01 Summary`. Use the same number beside each area
title and beside its table-of-contents link. When a conditional area is
omitted, do not leave a gap.

Summary previews the most important review items. Keep the complete **Review
items** section in a native disclosure that starts closed; a fragment link to a
specific item opens it. This keeps the first reading path focused without
removing the full finding, effect, next step, completion condition, or evidence.

Keep background in Summary. In Behavior change, show the core change first,
then any behavior model, the understanding check, and teaching aid choices.
Give each behavior model a visible subheading so its application conditions
and flow cannot look like another core-change claim. Teaching aid choices and
understanding checks are supporting details, not parallel top-level
destinations.

Let the reading path answer these questions in order:

1. What changed?
2. Why does it matter?
3. How do previous and new behavior differ?
4. Under which conditions does the outcome change?
5. What did the review find, and what limited the judgment?
6. What implementation and evidence support that explanation?

This is a reader-question order, not a fixed six-question template. Omit a
question that does not apply instead of creating an empty or repetitive block.

Explain behavior before code. Keep functions, types, file mechanics, and code
steps in a collapsed **Implementation details** group inside Evidence and
scope. In the main path, translate source states and callback return values into
the human choice, condition, and outcome they represent.

Show only the code excerpts needed for understanding instead of reproducing the
full diff.

Keep important evidence beside the claim it supports.

Keep inline evidence controls quiet and collapsed until requested. Use a
24-pixel summary on a wide screen and a 44-pixel touch target on a narrow
screen. Use thin dividers, whitespace, and type hierarchy before introducing a
contained box.

Use Evidence and scope as the complete index of the captured snapshot, checked
files, supporting sources, exclusions, and limits.

This order is informed by research showing that context supplied before a
passage improves comprehension and recall
([Bransford and Johnson, 1972](https://doi.org/10.1016/S0022-5371(72)80006-9)),
pre-training on a system's parts helps people build a mental model
([Mayer, Mathias, and Wetzell, 2002](https://pubmed.ncbi.nlm.nih.gov/12240927/)),
and headings and previews direct attention in complex text
([Lorch and Lorch, 1996](https://doi.org/10.1037/0022-0663.88.1.38)). The main
path keeps secondary implementation mechanics folded while a new reader builds
the first mental model, informed by research on the processing cost that can
compete with learning
([Sweller, 1988](https://doi.org/10.1207/s15516709cog1202_4)). Use a diagram
only when its spatial structure makes a relationship or inference easier to
find than equivalent prose
([Larkin and Simon, 1987](https://doi.org/10.1111/j.1551-6708.1987.tb00863.x)).

Keep repository identity, the reviewed commit, a visible pull-request link, and
artifact controls in one compact product bar. Use the same folder mark,
repository type treatment, display-control group, and contents treatment as
Align. Present the reviewed commit with the same quiet status treatment that
Align uses for its current version. Keep the pull-request link outside the
display-control group and preserve it when repository text is hidden at narrow
widths. Group the language dropdown and bordered theme button as one control.
Use a numbered desktop contents rail when it fits. Show the current section
with an accent bar, a quiet tinted background, and its position in the reading
order. Otherwise use an icon beside the display-control group and open the
same contents treatment in a bounded right-side panel.

## Align artifact direction

The Align artifact should feel like a compact project specification: direct,
quiet, easy to scan, and complete enough to guide implementation.

The Align feature's `scripts/design/tokens.mjs` owns its exact visual values.
Diff rendering, Diff tokens, and removed Align implementations do not constrain
it.

## Align artifact structure

The artifact is the current implementation agreement, not a progress tracker.

Show each fact once, in this order:

1. title, then a summary whose first row is the one-sentence goal;
2. problem, completion criteria, and governing boundary;
3. included and excluded scope;
4. compared design directions and the selected option, only when material UI
   design needed visual agreement;
5. agreed behavior, only when sequence or branching is clearer than prose;
6. confirmed decision titles, their folded reasons, and decisions left to
   implementation;
7. supporting evidence, only when it adds a source that matters.

Keep earlier versions in the secondary version history navigation. Do not
repeat version history at the bottom of the agreement.

Keep repository identity, current version, and theme control in the compact
product bar. Use **current agreement**, not language that implies an external
approval workflow.

The whole document is the implementation contract. Do not repeat it in a
separate contract summary.

Keep conclusions, actions, boundaries, behavior, and unresolved choices
visible. Fold verification methods, decision reasons, option references, and
the supporting-evidence section. Use these information roles directly; do not
add length or item-count thresholds that make the same field change layout
unpredictably.

Show each completion criterion as one visible passing condition. Keep its
verification method and the agent-or-person decision source in a native
disclosure directly below it. Keep completion criteria in the summary near the
goal. Do not turn them into progress controls or store their execution results
in the artifact. Use a compact 24-pixel summary on a wide screen and a 44-pixel
touch target on a narrow screen.

Number every completion criterion in reading order with `01`, `02`, `03`, even
when the list is short. Use body prose weight for each passing condition,
reserve stronger emphasis for the number, and keep the verification source
label quiet and secondary.

Do not show implementation progress, completion controls, work owners, comments,
changed files, test status, or model and interview metrics.

## Project GUI controls

Add a control only when a Hope feature needs the action or choice. Use the
platform's native semantics and behavior unless a feature contract requires a
different implementation.

Use buttons for actions and links for navigation. Give every control a visible
label or an accessible name, preserve visible keyboard focus, and never rely on
color or hover alone to communicate state.

Prefer native disclosures, selects, and scrolling when they satisfy the
feature contract. Keep destructive actions explicit, label actions by their
result, and explain a recoverable failure beside the affected work.

Feature sections below own the concrete controls, dimensions, states, and
interaction checks used by each artifact. External design sources may inform a
review, but they do not define Hope's GUI contract.

## Align artifact layout

Use one linear document. Give the current agreement most of the page and keep
version history secondary.

Place the unnumbered document title first. Start the numbered reading areas
below it with a visible `01 Summary`. Use the same number beside each area
title and beside its table-of-contents link. Omitted optional areas do not
leave gaps. Keep each section number the same type size and line height as its
title.

Give every numbered area one clear divider directly below its title. Do not add
a second rule above the area. Combine margin and padding into 40 pixels between
the document title and Summary. Between later areas, use 48 pixels on a wide
screen and 40 pixels on a narrow screen. Use the smaller internal spacing steps
for related content inside one area.

On a wide screen, place a narrow rail beside the document. Show a table of
contents only when it improves navigation. Keep the current version and at
most one prior version summary visible. Open earlier version detail from that
history instead of repeating it in the document.

Put one 44-pixel navigation control to the
right of the theme control and open the table of contents and version history in
a bounded right-side panel when the navigation rail does not fit. Treat included
and excluded scope as one parallel classification: compare them in two columns
on a wide screen, then stack included scope before excluded scope on a narrow
screen. Do not choose the layout from item length or count.

Render agreed behavior as one ordered vertical sequence at every viewport.
Keep each step's number beside its title and place the detail below the title.
Stack outcomes after the sequence in their original order. Do not invent phase
groups or branches that the artifact data does not contain.

In the product bar, use the same folder mark and repository type treatment as
Diff. Group the language dropdown and bordered theme button as one display
control, separate from navigation. Use one gap between the brand, repository,
version, and action group. Use the next smaller gap only between controls inside
the action group. Do not add one-off margins to an individual product-bar item.

Number agreed decisions in reading order.

Use thin dividers instead of enclosing ordinary content in cards. Give the
document title enough emphasis to establish the reading path, then keep body
type compact and readable. Omit an optional section instead of rendering an
empty box.

Show two or three design directions together in one comparison section. Keep
the same option order. Keep recommendation and selection labels beside the
option title so they do not create a separate comparison row. On a wide screen,
compare each option's title, image,
brief summary, strengths, and trade-offs in parallel; align those shared rows
across the options and stack each complete option on a narrow screen. Inside
each option, put strengths and trade-offs before recommendation and selection
reasons, then put folded references last. Keep the reasons and references
inside the option they explain. Do not repeat these details in a full-width
group below the comparison. Put only context shared by all options below the
comparison in one reading column. Pair every image with useful alt text, and
mark recommendation and selection with words rather than color alone.

Align embeds Hope Sans so it uses the same Hope type family as Diff across
supported hosts. Its palette, spacing, type sizes, and layout values still come
only from Align's own tokens.

## Hope artifact branding

Align, Diff, and Commit Diff embed the fixed Hope Sans files and Hope product
icon under `plugins/hope-commit/assets/`. Diff and Commit Diff also embed Hope
Code from the same asset folder.
Each feature still owns how those assets are applied in its renderer.

Put the Hope icon immediately before **HOPE** in both product bars. Keep the
visible wordmark as the accessible name; the icon is decorative.

## Diff artifact layout

Use one linear document in every viewport.

On a wide screen:

- keep the main text at a readable width;
- place a compact table of contents beside it when space allows;
- keep the product bar compact and place the artifact title in the document;
- keep dense body text intentionally smaller than mobile text; and
- do not stretch paragraphs across a large monitor.

On a narrow screen:

- keep the same information order and status language;
- use one column;
- put a compact native collapsible table of contents in the product bar;
- do not give the closed table of contents its own body row or vertical gap;
- open its links in a bounded panel directly below the product bar;
- keep the panel vertically scrollable without passing its scroll gesture to
  the document;
- close the open panel with Escape and return focus to its control; and
- use larger body text and touch targets.

Group the language dropdown and theme control as one 44-pixel display control.
Give the theme segment a visible boundary. Keep the pull-request link outside
that group. When the display and contents controls appear together, give both a
44-pixel height, the same border role, and the same corner radius.

An icon-only control may be narrower, but it must not look like a smaller
control family.

The product bar owns repository and pull request identity.

The document owns the change-based artifact title. Summary owns the goal. The
product bar owns the compact reviewed commit, and collapsed review information
owns capture time.

Do not repeat repository identity.

Do not add a persistent sentence that explains that an offline artifact does not
update itself.

A complex drawer is allowed only after its focus, keyboard, scroll, and deep
link behavior is tested.

## Diff artifact type

Use three clear roles.

| Role | Font |
| --- | --- |
| Body prose | Hope Sans Light, from Gmarket Sans |
| Wordmark, controls, labels, and headings | Hope Sans Medium or Bold |
| Code, commands, paths, and hashes | Hope Code, from D2Coding |

Embed the fixed WOFF2 files in every offline artifact.

Commit Diff also embeds the complete OFL notices in its offline artifact so a
standalone HTML copy carries the license terms for its bundled fonts.

Use a local sans-serif or monospace fallback only for characters that the
bundled fonts do not contain.

Do not synthesize a missing font weight.

Hope presents the converted files under Hope-owned family names because both
source licenses reserve their original family names.

Keep their source hashes, build commands, and licenses beside the shared fonts
under `plugins/hope-commit/assets/fonts/`.

Use the same compact prose scale as Align and adjust it only through named
tokens. Diff keeps a separate code scale:

| Use | Wide screen | Narrow screen |
| --- | --- | --- |
| Main body | 14px / 1.58 | 14px / 1.6 |
| Supporting text | 12px / 1.55 | 12px / 1.55 |
| Code | 13px / 1.35 | 14px / 1.35 |
| Page title | 32px / 1.2 | 28px / 1.2 |
| Section title | 18px / 1.4 | 16px / 1.4 |

Keep prose near 60–80 characters per line.

Long paths and code may scroll inside their own region.

Text-bearing controls use a minimum height and grow when text is enlarged.

They must not create page-level horizontal scrolling.

## Diff artifact space and boundaries

Use Align's small, consistent spacing scale.

Do not invent a new gap for each component.

```text
4 · 8 · 12 · 16 · 24 · 32 · 40 · 48 · 64
```

Give each top-level section a clear start.

Use a blue section number, a text-colored title, a clear title divider, and
measured space. Match Align's 48-pixel wide-screen and 40-pixel narrow-screen
separation between top-level areas.

Number conditional sections in their rendered order so the document and its
table of contents agree.

Use one clear divider directly below each top-level section title instead of a
second rule above the section or a line extending through its body.

Use two border roles:

- a quiet divider for document structure; and
- a stronger component border for controls, code, and separate task or state
  regions.

Give an adjacent vertical boundary to the later block's top edge. Within a
repeated group, put the divider on each item after the first. Do not combine a
previous block's bottom border with the next block's top border.

Do not draw a strong rule between every sentence or row.

Do not nest full component borders inside the first-screen summary.

Compact summary items use rows; their detailed versions may use cards later in
the document.

Use one quiet marker gutter to help the eye follow body content:

- ordinary paragraphs have no marker;
- two or more parallel claims use one small dot each;
- ordered behavior and code steps use `01`, `02`, `03`;
- a status dot, section number, disclosure arrow, or other existing marker is
  not paired with another generic bullet; and
- nested lists stop after one level and use a neutral marker inside.

Keep the first-screen review result especially compact.

Render each preview as a small kind marker, plain importance text, and title.

Do not add a representative status, total, or kind counts above the previews.

When no item exists, show one plain empty-result sentence.

Show concrete material scope limits without a generic scope badge.

Omit that synopsis row when no material limit exists.

Use the same label-and-value grid as the other synopsis rows.

Separate preview items with spacing, not rules.

Use semantic `ul` and `ol` elements for content that is a list.

Put the unnumbered change-based artifact title first. Start the self-contained
synopsis below it with a visible `01 Summary`. Render the goal as the first
label-and-value row, using the same label type, spacing, and divider rhythm as
the other summary rows. Keep the provider's pull-request title and capture time
in collapsed review information.

Use the same section-title divider rhythm as Align. Keep each section number
the same type size and line height as its title.

In each full review item, align kind, importance, and basis on one visual
centerline.

Keep kind and importance as outlined markers and basis as quieter plain text.

Render behavior steps as one connected vertical sequence at every viewport.
Keep the same two-digit number gutter, text, and order in Align and Diff. This
keeps the reading path stable when a step contains longer prose and reserves
horizontal columns for direct comparison.

## Align artifact color and themes

Generate one Align artifact that supports light and dark themes.

The light view uses a warm near-white document surface, near-black text, thin
neutral dividers, and blue for navigation and agreement state. The dark view
uses a near-black surface, off-white text, quiet gray dividers, and a brighter
blue accent.

Exact Align values live only in
`plugins/hope-commit/skills/align/scripts/design/tokens.mjs`.

The initial theme comes from the artifact input: `system`, `light`, or `dark`.
The theme button changes only the open document. It does not write browser
storage or host configuration, and reload restores the generated initial
theme. Print uses the Align light surface.

## Diff artifact color and themes

Generate one Diff artifact that supports light and dark themes.

The official light palette is `Sand Paper`: the same warm near-white page and
slightly brighter reading surface used by Align.

It should feel softer than pure white without looking beige or gray.

Exact Hope surface values live only in the Diff feature's
`scripts/design/tokens.mjs`.

Code is a separate visual surface with fixed Hope light and dark colors.

A theme change switches both at once.

It does not replace the Hope palette outside code.

Insert repository text only as escaped content.

Keep source lines explicit in the document and distinguish patch additions,
deletions, context, and hunk headers without a stateful language parser.

The initial theme comes from the resolved Diff display option:

- `system`;
- `light`; or
- `dark`.

The theme control changes only the open document.

It does not write host configuration or browser storage.

Reloading returns to the generated initial theme.

Print uses a light surface.

Use these status roles:

| Meaning | Color role |
| --- | --- |
| Resolve | Red |
| Decide | Amber |
| Verify | Blue |
| Scope | Neutral blue-gray |

Importance stays in text.

Never use color as the only status signal.

## Diff artifact interaction

Every interaction must still leave useful content when JavaScript is disabled.

Use trusted, fixed scripts only.

Supported interactions can include:

- open or close evidence;
- move through the table of contents;
- switch the current document theme;
- try a safe declarative microworld;
- draft an optional quiz response without submitting or saving it; and
- reveal the quiz answer and evidence through a separate disclosure.

Keep a microworld's title, instructions, and model warning visible. Fold its
controls, scenarios, simplifying assumptions, omissions, and evidence into one
native disclosure. These are optional exploration details, not prerequisites
for understanding the behavior summary and flow.

Use the visible quiz question as the response field's persistent label.

When that question and a clear placeholder make the purpose evident, do not
repeat a generic visible label such as **My answer** or **Selection**.

Keep the question programmatically associated with the field and retain an
accessible name for assistive technology.

A response is never required before the answer can be opened.

Give repeated controls a unique accessible name by associating each one with its
question.

Print output omits the reader's transient quiz response.

It shows every review item, microworld detail, question, answer, and supporting
evidence regardless of the current disclosure state.

The **Evidence and scope** section is a dense reference appendix.

Keep the whole section open initially so the available groups remain visible.

Its source groups, context checks, scope limits, checked-file group, and
artifact details must open independently and start closed.

Use native disclosure controls so they work without JavaScript.

Opening a fragment link must reveal every disclosure that contains its target.

Code markup must contain explicit line separators.

One source line must remain one visible line even without layout styles; long
lines scroll inside the code surface instead of merging with adjacent lines.

Do not make audit completeness look like repeated interface content.

Merge changed-file source metadata into the changed-file table, keep other
sources in a separate small table, and group exclusions with the same reason.

Keep the collapsed interface compact.

A closed disclosure occupies only its summary row and borders. It must not
reserve body padding or leave unused parent spacing below the row.

Keep the understanding-check subsection visible when it is present. Let each
question and its answer open independently instead of collapsing the whole
subsection.

Expanded details must still account for every source, file, and limit.

Do not show a section-copy control while artifacts use temporary local paths.

Stable section IDs remain available for navigation.

Add copying only when Hope has a portable publication URL and can show visible
success feedback.

Do not add task completion, assignment, comments, or hidden persistence.

## Hope artifact accessibility

Target WCAG 2.2 AA.

Every artifact needs:

- one `h1` and a valid heading order;
- landmarks and a skip link;
- visible keyboard focus;
- text labels for every status;
- sufficient contrast in both themes;
- reduced-motion and forced-colors support;
- useful content at 200% text zoom and 400% page zoom;
- a text alternative for every diagram or interactive explanation; and
- correct `lang`, `dir`, and bidirectional isolation for mixed content.

Keep mobile controls at least 44 by 44 CSS pixels.

On a narrow screen, keep status and control labels at 12px or larger.

When an artifact embeds typefaces, supporting labels and interactive summaries
use its medium face and body prose uses its light face.

Test the final file through `file://`, not only through a web server.

## Hope artifact implementation boundary

Repository, provider, and model content is untrusted.

Each renderer inserts authored prose as text and never accepts authored HTML,
CSS, JavaScript, or SVG. Diff separately validates the source URLs it owns;
Align renders only `http` and `https` evidence locations as links.

Align may embed raster design-direction images only after its runtime verifies
their supported signature, dimensions, and size. It never treats an authored
data URL or SVG as a design-direction image.

Design code may contain feature-local tokens, fixed assets, and small helpers.

Each feature owns its concrete HTML, tokens, and publication boundary. Keep
Align, Diff, and Commit Diff rendering, state, and design sources separate
until another exact invariant earns shared implementation.
