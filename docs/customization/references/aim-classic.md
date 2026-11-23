# AIM Classic visual reference

The target is the classic Windows AIM directory-and-chat arrangement, using Windows Classic control treatments and an original OpenPane palette. This is a visual adaptation with real OpenPane agents and actions. It does not reproduce AOL branding, contacts, formatting commands or network behavior.

## Traceable reference

Inspected on November 23, 2026:

- [How to Use AIM](https://www.slideserve.com/duard/how-to-use-aim) identifies its tutorial date as March 5, 2007; the hosting page records an October 2014 upload. Its original screenshots show the older classic client appearance still in use at that date. They do not establish an exact AIM executable version or a 2002 capture date.
- [Buddy List screenshot](https://image3.slideserve.com/5613640/buddy-list-l.jpg): narrow upright directory, neutral gray chrome, inset white list, compact text rows and visibly unavailable entries.
- [Conversation screenshot](https://image3.slideserve.com/5613640/iming1-l.jpg): blue caption, white inset transcript, red local and blue remote author labels, rectangular text-entry well and beveled action controls. An actual chat fills most of its window rather than appearing in a rounded conversation bubble.
- [Empty conversation screenshot](https://image3.slideserve.com/5613640/send-an-im-l.jpg) establishes caption, transcript/input proportions before messages arrive.
- [XP.css](https://botoxparty.github.io/XP.css/) supplies a separate semantic-control reference. Planning inspected upstream revision `376f42eb274361939eaad3b0943204c053ad26c4` (package 0.2.6). The implementation uses original recipes; it does not import upstream CSS, fonts or artwork.

The earlier AIM+ vendor screenshots were discoverable but their files timed out from the implementation environment. They are not claimed as inspected evidence.

Reference images are linked, not bundled or redistributed. OpenPane test captures use only recorded agents and synthetic data.

## Compare the whole interface

Compare a matched-size directory and a conversation in the actual packaged app and browser. Check these visible traits together:

1. Neutral chrome and compact directory rows, without the modern oversized sidebar spacing.
2. Blue caption bands, selected rows and readable disabled-state explanations.
3. Raised buttons that depress on activation, square input wells and visible keyboard focus.
4. Speaker-labelled lines with red/blue author distinction, readable markdown/code and a rectangular composer.
5. A populated saved metric card whose frame and controls share the same palette and edges.

OpenPane keeps real Settings, Extensions, Send, Stop and approval actions. It does not draw inert historical menu/formatting/warn/block controls. Native macOS title bars, traffic lights, overlay scrollbars, local font substitution, 24px fine-pointer targets, 44px coarse/hybrid targets and modern accessibility are deliberate differences. Record the rendered font, directory row count, caption clearance and drag behavior during qualification. No pixel-exact historical claim is made.
