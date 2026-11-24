#!/usr/bin/env fish
# Run this inside your cipher-chat folder AFTER copying the new files over it.
# 17 commits, in an order where the app still starts after each one.
# Check first with: git status

function c
    set msg $argv[1]
    set files $argv[2..-1]
    git add $files
    and git commit -q -m "$msg" -m "Co-authored-by: Claude <noreply@anthropic.com>"
    or begin
        echo "failed on: $msg"
        return 1
    end
end

c "db: audiences, edits, hidden posts, post media, close friends and reports" backend/db.py
c "feed: one place that decides who can see which post" backend/postaccess.py
c "feed: rules for words and an optional picture check" backend/moderation.py backend/blocked_terms.txt
c "feed: upload pictures, videos and songs for posts and serve them safely" backend/media.py
c "chat: GIF library and an optional GIPHY search through the server" backend/gifs.py
c "feed: edit posts, repost, liked-by list, reports, moderators, close friends" backend/feed.py
c "settings: post audience, likes privacy, repost and share switches; wire up the new modules" backend/main.py
c "tests: feed audiences, media, likes, reports, close friends and GIFs" tests/test_feed.py tests/test_feed_v2.py tests/test_backend.py
c "web: format and tests for a post sent in a chat" web/postwire.js tests/postwire.test.mjs
c "web: small popup windows with Escape and focus handling" web/dialogs.js
c "web: the feed is a page of its own, with tabs, liked-by names and reposts" web/feed.js web/feed.css
c "web: write and edit posts with photos, video, music and an audience" web/feed-compose.js
c "web: Share sends a post to chats, and shared posts show as cards" web/feed-share.js web/attachments.js
c "web: GIF button and picker in chats" web/gifs.js web/gifs.css
c "web: settings page with Messages, Posts and Close friends" web/settings.js web/style.css
c "web: feed page, GIF button and new scripts in index.html" web/index.html
c "docs: the feed, keeping it clean, GIFs and new settings" README.md

echo "done, now: git push"
