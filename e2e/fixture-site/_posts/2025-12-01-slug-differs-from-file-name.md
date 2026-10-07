---
title: Slug differs from file name
slug: front-matter-slug-wins
date: 2025-12-01 09:00:00 +0000
tags: [Welcome]
published: true
---

This public post's front-matter `slug:` differs from its file name. Jekyll's
`permalink: /blog/:slug/` serves it at `/blog/front-matter-slug-wins/`, and the
admin Posts list must link that address, not one built from the file name
(`/blog/slug-differs-from-file-name/` is a 404). The platform's own admin link
crawler (`e2e/cms-link-crawler.spec.js`) HEADs the list's links, so this post
keeps that contract covered here.
