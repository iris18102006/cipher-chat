#!/usr/bin/env fish
# Makes about 100 small commits for the feed update.
# 1. Copy the new files over your cipher-chat folder (the zip), run `git status` to see them.
# 2. Run this script from the cipher-chat folder:  fish commit-many.fish
# 3. git push
# Don't run it together with commit-feed.fish, they make the same changes in different sizes.
# While it runs some files are only part written, so don't start the server until it says done.

git rev-parse --is-inside-work-tree >/dev/null 2>&1; or begin; echo 'run this inside the cipher-chat folder'; exit 1; end
test -e backend/feed.py; or begin; echo 'copy the new files in first'; exit 1; end

# keep a copy of the finished files, the commits below write them in pieces
set finals backend/postaccess.py backend/moderation.py backend/media.py backend/gifs.py backend/feed.py tests/test_feed_v2.py web/postwire.js tests/postwire.test.mjs web/dialogs.js web/feed.js web/feed.css web/feed-compose.js web/feed-share.js web/gifs.js web/gifs.css web/settings.js
for f in $finals
    mkdir -p .final-feed/(dirname $f)
    test -e .final-feed/$f; or cp $f .final-feed/$f
end

function c
    set msg $argv[1]
    set files $argv[2..-1]
    git add $files
    and git commit -q -m "$msg" -m 'Co-authored-by: Claude <noreply@anthropic.com>'
    or begin
        echo "failed on: $msg"
        exit 1
    end
end

# writes the first N lines of a finished file, then commits it
function p
    set f $argv[1]
    set n $argv[2]
    set msg $argv[3]
    sed -n "1,"$n"p" .final-feed/$f > $f
    c "$msg" $f
end

c 'db: audiences, edits, hidden posts, post media, close friends and reports tables' backend/db.py
p backend/postaccess.py 30 'feed access: start postaccess.py'
p backend/postaccess.py 70 'feed access: add blocked_with to postaccess.py'
cp .final-feed/backend/postaccess.py backend/postaccess.py; and c 'feed access: add Viewer to postaccess.py' backend/postaccess.py

p backend/moderation.py 43 'moderation: start moderation.py'
p backend/moderation.py 87 'moderation: add TERMS_FILE to moderation.py'
p backend/moderation.py 128 'moderation: add EXPLICIT_LABELS to moderation.py'
cp .final-feed/backend/moderation.py backend/moderation.py; and c 'moderation: add _nudenet_detector to moderation.py' backend/moderation.py

c 'moderation: an editable list of blocked phrases' backend/blocked_terms.txt
p backend/media.py 44 'post media: start media.py'
p backend/media.py 85 'post media: add VIDEO_BRANDS to media.py'
p backend/media.py 116 'post media: add media_json to media.py'
p backend/media.py 167 'post media: add plan to media.py'
p backend/media.py 208 'post media: add route post-media to media.py'
cp .final-feed/backend/media.py backend/media.py; and c 'post media: add route post-media media_id to media.py' backend/media.py

p backend/gifs.py 35 'gifs: start gifs.py'
p backend/gifs.py 79 'gifs: add API to gifs.py'
p backend/gifs.py 126 'gifs: add _media to gifs.py'
p backend/gifs.py 157 'gifs: add _need_search to gifs.py'
p backend/gifs.py 200 'gifs: add route gifs media gid size to gifs.py'
cp .final-feed/backend/gifs.py backend/gifs.py; and c 'gifs: add route me gifs to gifs.py' backend/gifs.py

p backend/feed.py 39 'feed api: start feed.py'
p backend/feed.py 83 'feed api: add PostBody to feed.py'
p backend/feed.py 130 'feed api: add clean_words to feed.py'
p backend/feed.py 176 'feed api: add plain_post to feed.py'
p backend/feed.py 208 'feed api: add one_post to feed.py'
p backend/feed.py 254 'feed api: add route posts to feed.py'
p backend/feed.py 291 'feed api: add route posts post_id to feed.py'
p backend/feed.py 333 'feed api: add route feed meta to feed.py'
p backend/feed.py 378 'feed api: add route posts post_id likes to feed.py'
p backend/feed.py 406 'feed api: add reports and moderators to feed.py'
p backend/feed.py 457 'feed api: add route admin reports to feed.py'
cp .final-feed/backend/feed.py backend/feed.py; and c 'feed api: add close friends to feed.py' backend/feed.py

c 'main: post settings, close friends cleanup on unfriend or block, wire up the new modules' backend/main.py
c 'tests: feed tests now use repost and the new like reply' tests/test_feed.py
c 'tests: settings reply has the new post settings' tests/test_backend.py
p tests/test_feed_v2.py 45 'tests: start test_feed_v2.py'
p tests/test_feed_v2.py 90 'tests: add test_only_me_is_only_me to test_feed_v2.py'
p tests/test_feed_v2.py 136 'tests: add test_words_are_checked to test_feed_v2.py'
p tests/test_feed_v2.py 180 'tests: add test_video_and_song_sniffing_and_ranges to test_feed_v2.py'
p tests/test_feed_v2.py 226 'tests: add the picture check to test_feed_v2.py'
p tests/test_feed_v2.py 260 'tests: add repost and chat share rules to test_feed_v2.py'
p tests/test_feed_v2.py 311 'tests: add test_reports_hide_a_post_until_a_moderator_looks to test_feed_v2.py'
cp .final-feed/tests/test_feed_v2.py tests/test_feed_v2.py; and c 'tests: add test_gif_library to test_feed_v2.py' tests/test_feed_v2.py

cp .final-feed/web/postwire.js web/postwire.js; and c 'post wire: start postwire.js' web/postwire.js

cp .final-feed/tests/postwire.test.mjs tests/postwire.test.mjs; and c 'tests: start postwire.test.mjs' tests/postwire.test.mjs

p web/dialogs.js 5 'dialogs: start dialogs.js'
p web/dialogs.js 61 'dialogs: add openDialog to dialogs.js'
cp .final-feed/web/dialogs.js web/dialogs.js; and c 'dialogs: add plainButton to dialogs.js' web/dialogs.js

p web/feed.js 37 'feed page: start feed.js'
p web/feed.js 72 'feed page: add feedError to feed.js'
p web/feed.js 117 'feed page: add mediaNode to feed.js'
p web/feed.js 151 'feed page: add postBody to feed.js'
p web/feed.js 171 'feed page: add likes reposts sharing edit delete report to feed.js'
p web/feed.js 229 'feed page: add paintEngage to feed.js'
p web/feed.js 252 'feed page: add afterChange to feed.js'
p web/feed.js 298 'feed page: add repostDialog to feed.js'
p web/feed.js 339 'feed page: add reportDialog to feed.js'
p web/feed.js 365 'feed page: add deletePost to feed.js'
p web/feed.js 410 'feed page: add loadFeed to feed.js'
p web/feed.js 444 'feed page: add the page opening closing tabs to feed.js'
p web/feed.js 484 'feed page: add showFeed to feed.js'
p web/feed.js 520 'feed page: add closeSingle to feed.js'
p web/feed.js 558 'feed page: add for moderators reported posts to feed.js'
cp .final-feed/web/feed.js web/feed.js; and c 'feed page: add loadReports to feed.js' web/feed.js

p web/feed.css 58 'feed styles: start feed.css'
p web/feed.css 113 'feed styles: add #feed-layout to feed.css'
p web/feed.css 170 'feed styles: add #feed-tabs button to feed.css'
p web/feed.css 223 'feed styles: add #feed-compose-box to feed.css'
p web/feed.css 277 'feed styles: add .fc-chip.fc-image to feed.css'
p web/feed.css 334 'feed styles: add .fc-chars to feed.css'
p web/feed.css 389 'feed styles: add keyframes feed-flash to feed.css'
p web/feed.css 446 'feed styles: add .feed-body to feed.css'
p web/feed.css 503 'feed styles: add .feed-pics.n3 imgfirst-child to feed.css'
p web/feed.css 560 'feed styles: add .feed-likes.linkhovernotdisabled to feed.css'
p web/feed.css 616 'feed styles: add .dlg-overlay to feed.css'
p web/feed.css 672 'feed styles: add .feed-repost-form textarea to feed.css'
p web/feed.css 727 'feed styles: add .share-group-icon to feed.css'
cp .final-feed/web/feed.css web/feed.css; and c 'feed styles: add .chat-post-text b to feed.css' web/feed.css

p web/feed-compose.js 29 'post composer: start feed-compose.js'
p web/feed-compose.js 57 'post composer: add uploadPostMedia to feed-compose.js'
p web/feed-compose.js 267 'post composer: add makeComposer to feed-compose.js'
cp .final-feed/web/feed-compose.js web/feed-compose.js; and c 'post composer: more of feed-compose.js' web/feed-compose.js

p web/feed-share.js 22 'share to chat: start feed-share.js'
p web/feed-share.js 101 'share to chat: add shareDialog to feed-share.js'
p web/feed-share.js 105 'share to chat: add a post inside a chat to feed-share.js'
cp .final-feed/web/feed-share.js web/feed-share.js; and c 'share to chat: add fetchPostForChat to feed-share.js' web/feed-share.js

c 'chat: shared posts show as cards, GIF button follows the message box lock' web/attachments.js
p web/gifs.js 41 'gif picker: start gifs.js'
p web/gifs.js 79 'gif picker: add sendGif to gifs.js'
p web/gifs.js 164 'gif picker: add paintGifs to gifs.js'
cp .final-feed/web/gifs.js web/gifs.js; and c 'gif picker: add runSearch to gifs.js' web/gifs.js

p web/gifs.css 37 'gif styles: start gifs.css'
p web/gifs.css 79 'gif styles: add .gif-tabs button.on to gifs.css'
cp .final-feed/web/gifs.css web/gifs.css; and c 'gif styles: add .gif-grid to gifs.css' web/gifs.css

p web/settings.js 31 'settings: start settings.js'
p web/settings.js 80 'settings: add saveSetting to settings.js'
p web/settings.js 98 'settings: add toggleRow to settings.js'
p web/settings.js 142 'settings: add closeFriendsBox to settings.js'
cp .final-feed/web/settings.js web/settings.js; and c 'settings: add openSettings to settings.js' web/settings.js

c 'settings: keep the saved status in view at the bottom' web/style.css
c 'web: feed page, GIF button and the new scripts in index.html' web/index.html

# every file must now be exactly the finished one
set bad 0
for f in $finals
    cmp -s $f .final-feed/$f; or begin; echo "not finished: $f"; set bad 1; end
end
if test $bad = 0
    rm -rf .final-feed
    echo 'done:' (git rev-list --count HEAD) 'commits in total, now: git push'
else
    echo 'something is off, the finished copies are still in .final-feed'
end
