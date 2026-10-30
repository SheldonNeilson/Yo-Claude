// The assistant's name, from the character picked in Options > Assistant: Claudia (female) or Claude (male, the
// default). Used for every "claude" the window shows (not Claude Code, the program underneath). Loaded first.
"use strict";
window.who = () => ((typeof S !== "undefined" && S.settings?.character === "female") ? "claudia" : "claude");
window.Who = () => who()[0].toUpperCase() + who().slice(1);
