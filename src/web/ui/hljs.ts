// The hljs instance: core plus the curated language set (the full bundle is
// ~1MB). Its own module because it is its own chunk — highlight.ts reaches it
// with a dynamic import, so a page that shows no code never downloads a
// highlighter.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({ bash, css, diff, go, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml }))
  hljs.registerLanguage(name, language);

export default hljs;
