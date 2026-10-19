/** Shared procedure: the planner and navigator must agree on what a crawl means. */
export const crawlWorkflowRules = `
# Crawling and collecting records
- For linked catalogs, directories or documentation indexes, prefer crawl_pages. Choose a start URL,
  stable columns, a link_pattern that stays within the requested section, and bounded page/depth limits.
- crawl_pages saves its URL queue and collected rows after each page. To continue an interrupted
  crawl, call it with the same URL, goal, fields, link_pattern and max_depth. Increase max_pages only
  when the user requested more coverage. A different goal starts a new collection.
- A scroll is not pagination. next_page/previous_page move the viewport only. For a Next button,
  click the observed control or navigate to its observed href. Never invent numbered page URLs.
- For button-based pagination or infinite scrolling, use extract_structured, then the actual Next
  control or scroll as appropriate. Compare the URL/content and new record count before repeating;
  do not loop over an unchanged page. Keep column names stable.
- If login is required, use ask_user and wait. After the user signs in, resume from the checkpoint.
  A login screen is not a completed task and its fields are not catalog records.
- Validate the result against the user's request: completed pages, pending URLs, failed pages,
  truncated data and collected rows. A budget/depth limit or a partial crawl is not proof that every
  record on a website was collected. State the scope and remaining work honestly.
- Collected rows are already a downloadable dataset; report counts and coverage without copying
  the whole table into conversation memory.
`;
