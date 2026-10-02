Project X Tier 1 Render source review build
Base repository: https://github.com/Sam-Rideout/sdp-backend
Base branch: main
Base commit: b27c2dae02b41f91c2aa94763a804795104fa768
Render build/start commands remain: npm install; node server.js.

This review build replaces the microphone-only test page with member-authenticated
section/take capture, consent-version metadata, and verified local-transfer code.
It is intentionally not enabled for new sessions until approved consent wording
and all section prompts are installed.

Included: Node app, source and deployment/dependency files, Wix code snippets,
PC transfer utility, configuration, and regression test.
Excluded: .git metadata, node_modules, recordings/user-specific outputs, master
audio assets, chord audio assets, and environment secrets.
