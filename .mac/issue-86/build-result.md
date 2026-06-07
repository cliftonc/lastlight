# Build result

- final verdict: APPROVE
- review cycles: 0
- files changed: skills/reverser/SKILL.md, skills/reverser/index.ts, src/engine/chat-skills.ts

## Code diff
```diff
diff --git a/skills/reverser/SKILL.md b/skills/reverser/SKILL.md
new file mode 100644
index 0000000..d8e7953
--- /dev/null
+++ b/skills/reverser/SKILL.md
@@ -0,0 +1,15 @@
+# Reverser
+
+Reverse a string, word, or sentence.
+
+## Actions
+
+- `reverse_string`: Reverse a string.
+- `reverse_word`: Reverse a single word.
+- `reverse_sentence`: Reverse a sentence (preserving word order).
+
+## Examples
+
+- `reverse_string("hello")` → `"olleh"`
+- `reverse_word("world")` → `"dlrow"`
+- `reverse_sentence("hello world")` → `"world hello"`
\ No newline at end of file
diff --git a/skills/reverser/index.ts b/skills/reverser/index.ts
new file mode 100644
index 0000000..e828272
--- /dev/null
+++ b/skills/reverser/index.ts
@@ -0,0 +1,70 @@
+import type { Tool } from "@earendil-works/pi-ai";
+
+export const reverse_string: Tool = {
+  name: "reverse_string",
+  description: "Reverse a string.",
+  parameters: {
+    type: "object",
+    properties: {
+      input: {
+        type: "string",
+        description: "The string to reverse",
+      },
+    },
+    required: ["input"],
+  },
+  execute: (args) => {
+    const { input } = args;
+    return {
+      content: input.split("").reverse().join("")
+    };
+  },
+};
+
+export const reverse_word: Tool = {
+  name: "reverse_word",
+  description: "Reverse a single word.",
+  parameters: {
+    type: "object",
+    properties: {
+      word: {
+        type: "string",
+        description: "The word to reverse",
+      },
+    },
+    required: ["word"],
+  },
+  execute: (args) => {
+    const { word } = args;
+    return {
+      content: word.split("").reverse().join("")
+    };
+  },
+};
+
+export const reverse_sentence: Tool = {
+  name: "reverse_sentence",
+  description: "Reverse a sentence (preserving word order).",
+  parameters: {
+    type: "object",
+    properties: {
+      sentence: {
+        type: "string",
+        description: "The sentence to reverse",
+      },
+    },
+    required: ["sentence"],
+  },
+  execute: (args) => {
+    const { sentence } = args;
+    return {
+      content: sentence.split(" ").reverse().join(" ")
+    };
+  },
+};
+
+export default {
+  reverse_string,
+  reverse_word,
+  reverse_sentence,
+};
\ No newline at end of file
diff --git a/src/engine/chat-skills.ts b/src/engine/chat-skills.ts
index c058ed7..61c40f9 100644
--- a/src/engine/chat-skills.ts
+++ b/src/engine/chat-skills.ts
@@ -47,6 +47,7 @@ export const CHAT_SKILL_NAMES = [
   "issue-triage",
   "pr-review",
   "repo-health",
+  "reverser",
 ] as const;
 
 const SKILLS_ROOT = resolve("skills");

```