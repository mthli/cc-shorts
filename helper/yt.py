"""cc-shorts YouTube helper: the Shorts feed, downloads, watch history and likes.

    yt.py feed       stdin {"token": str | null, "seen": [videoId], "want": int}
                     prints {"ids": [videoId], "token": str | null,
                             "source": "sequence" | "home" | "subscriptions",
                             "loggedIn": bool}
    yt.py download ID DIR
                     downloads the Short into DIR/ID.mp4 and prints
                     {"id", "title", "author", "duration", "width", "height",
                      "hasAudio", "path"}
    yt.py watched ID marks the Short watched in the account's history
    yt.py like ID    likes the Short as the logged-in account
    yt.py unlike ID  takes the account's like (or dislike) off the Short

Every command prints one JSON line on stdout; errors go to stderr with a
non-zero exit.

`feed` scrolls the logged-in Shorts sequence: `token` is the
reel_watch_sequence continuation of the last call; pass it back to keep
scrolling. A missing or dead token starts over from the home page's Shorts
shelf; when the sequence API gives nothing at all, the subscriptions Shorts
feed is the fallback (and the token comes back null).

Cookies come through yt-dlp from the browser CC_SHORTS_BROWSER names, in
yt-dlp's words (chrome, safari, firefox, edge, brave...), Chrome's when it is
unset; one it cannot read (a Chromium browser whose key the Keychain does not
hand over included), and a `feed` it finds signed out, exit saying so.

Run with a Python that has yt_dlp, the one an installed yt-dlp runs on (the
system python3 has none); the mod finds it at startup by the `#!` line of the
`yt-dlp` on the PATH:
    ~/.local/pipx/venvs/yt-dlp/bin/python helper/yt.py feed <<< '{"want": 10}'
"""

import json
import os
import sys

import yt_dlp
import yt_dlp.cookies

BROWSER = os.environ.get('CC_SHORTS_BROWSER') or 'chrome'
HOME = 'https://www.youtube.com/'
SUBSCRIPTIONS = 'https://www.youtube.com/feed/subscriptions/shorts'
# One batch is ~15 Shorts: never pull more than this many per call, so the
# request rate stays near a person scrolling.
MAX_BATCHES = 3
# Width, not height: a vertical video's height is its long side.
FORMAT = 'bv*[width<=480][ext=mp4]+ba[ext=m4a]/b[width<=480]/b'

# yt-dlp takes the newest file named `Cookies` anywhere under Chrome's folder,
# and a Chrome extension keeps its own `Cookies` database under a profile's
# `Storage/` with no YouTube login in it: whenever that one was written last,
# every request went out logged out. Profiles never keep theirs there.
_find_files = yt_dlp.cookies._find_files


def _profile_files(root, filename, logger):
    for path in _find_files(root, filename, logger):
        if f'{os.sep}Storage{os.sep}' not in path:
            yield path


yt_dlp.cookies._find_files = _profile_files


class _YoutubeDL(yt_dlp.YoutubeDL):
    """A YoutubeDL that keeps the warnings `no_warnings` keeps off the screen."""

    def __init__(self, *args, **kwargs):
        self.warnings = []
        super().__init__(*args, **kwargs)

    def report_warning(self, message, only_once=False):
        self.warnings.append(message)
        super().report_warning(message, only_once)


def ydl(cookies=True, **params):
    base = {'quiet': True, 'no_warnings': True, 'noprogress': True}
    if cookies:
        base['cookiesfrombrowser'] = (BROWSER,)
    y = _YoutubeDL({**base, **params})
    if cookies:
        # Read now rather than at the first request, to see how it went: a
        # Chromium browser's cookies are encrypted with a key in the macOS
        # Keychain, and when the Keychain does not hand it over (Deny, or no
        # one there to answer) yt-dlp only warns and drops every encrypted
        # cookie, so each request goes out signed out.
        _ = y.cookiejar
        if any('find-generic-password' in w for w in y.warnings):
            raise yt_dlp.cookies.CookieLoadError('failed to load cookies') from PermissionError(
                'allow the macOS Keychain prompt for its key'
            )
    return y


def short_url(video_id):
    return f'https://www.youtube.com/shorts/{video_id}'


def main():
    cmd, args = sys.argv[1], sys.argv[2:]
    try:
        out = {'feed': feed, 'download': download, 'watched': watched, 'like': like, 'unlike': unlike}[cmd](*args)
    except yt_dlp.utils.YoutubeDLError as err:
        cause = cookie_failure(err)
        if cause is None:
            raise
        # Safari keeps its cookies where only an app with Full Disk Access
        # reads (Files & Folders does not reach them); the other browsers'
        # folders need no grant at all.
        if BROWSER == 'safari' and isinstance(cause, PermissionError):
            cause = 'give the terminal Full Disk Access in System Settings > Privacy & Security'
        sys.exit(f"cannot read {BROWSER}'s cookies: {cause}")
    json.dump(out, sys.stdout)
    print()


def cookie_failure(err):
    """What failed reading the browser's cookies, if that is what `err` came of; else None.

    yt-dlp reports it as a DownloadError raised while handling a
    CookieLoadError ("failed to load cookies"), itself raised while handling
    what failed; `ydl` raises one from what the Keychain refused.
    """
    while err is not None:
        if isinstance(err, yt_dlp.cookies.CookieLoadError):
            return err.__cause__ or err.__context__ or err
        err = err.__context__
    return None


def feed():
    req = json.load(sys.stdin)
    f = Feed(set(req.get('seen') or []), max(1, int(req.get('want') or 10)))
    token, source = req.get('token'), 'sequence'
    if token:
        try:
            token = f.scroll(token)
        except Exception as err:  # noqa: BLE001  a dead token reads as any API error
            print(f'feed: token failed, starting over: {err}', file=sys.stderr)
            token = None
    if not f.ids:
        source = 'home'
        try:
            token = f.from_home()
        except Exception as err:  # noqa: BLE001
            print(f'feed: home sequence failed: {err}', file=sys.stderr)
            token = None
    if not f.ids:
        # The subscriptions need a login too, and the home page signed out has no Shorts.
        if not f.logged_in:
            sys.exit(f"signed out: no YouTube login in {BROWSER}'s cookies")
        source, token = 'subscriptions', None
        f.from_subscriptions()
    return {'ids': f.ids, 'token': token, 'source': source, 'loggedIn': f.logged_in}


class Api:
    """InnerTube as the logged-in web page calls it: the browser's cookies, the home page's config."""

    def __init__(self):
        self.ie = ydl().get_info_extractor('YoutubeTab')
        self.page = self.ie._download_webpage(HOME, 'home', note=False)
        self.ytcfg = self.ie.extract_ytcfg('home', self.page)
        self.logged_in = bool(self.ytcfg.get('LOGGED_IN'))

    def call(self, endpoint, body):
        return self.ie._call_api(
            endpoint,
            body,
            endpoint,
            note=False,
            context=self.ytcfg.get('INNERTUBE_CONTEXT'),
            headers=self.ie.generate_api_headers(ytcfg=self.ytcfg),
        )


class Feed(Api):
    def __init__(self, seen, want):
        super().__init__()
        self.seen = seen
        self.want = want
        self.ids = []
        # Shared by every scroll of this call: a token that brings nothing new
        # leaves the home page's sequence only what it did not use.
        self.batches = MAX_BATCHES

    def scroll(self, token):
        """Pull sequence batches from `token`; returns the token after the last."""
        while self.batches > 0:
            self.batches -= 1
            res = self.call('reel/reel_watch_sequence', {'sequenceParams': token})
            self.add(video_ids(res.get('entries', [])))
            nxt = find_strings(res.get('continuationEndpoint', {}), 'token')
            if not nxt:
                return None
            token = nxt[0]
            if len(self.ids) >= self.want:
                break
        return token

    def from_home(self):
        """Seeds from the home page's Shorts shelf, then the sequence they start."""
        initial = self.ie.extract_yt_initial_data('home', self.page)
        seeds = {}
        for ep in find_all(initial, 'reelWatchEndpoint'):
            if isinstance(ep, dict) and ep.get('videoId'):
                seeds.setdefault(ep['videoId'], ep)
        if not seeds:
            return None
        self.add(seeds)
        seed = next(iter(seeds.values()))
        body = {
            'playerRequest': {
                'videoId': seed['videoId'],
                **({'params': seed['playerParams']} if seed.get('playerParams') else {}),
            },
            'disablePlayerResponse': True,
        }
        if seed.get('params'):
            body['params'] = seed['params']
        item = self.call('reel/reel_item_watch', body)
        token = (find_strings(item, 'sequenceContinuation') or [None])[0] or seed.get('sequenceParams')
        return self.scroll(token) if token else None

    def from_subscriptions(self):
        # A fresh instance: the subscriptions tab answers 401 to the one that
        # already fetched the home page.
        info = ydl(extract_flat=True, playlist_items='1:30').extract_info(SUBSCRIPTIONS, download=False)
        self.add(e['id'] for e in info.get('entries') or [] if isinstance(e, dict) and e.get('id'))

    def add(self, ids):
        for i in ids:
            if i not in self.seen and i not in self.ids:
                self.ids.append(i)


def video_ids(obj):
    """The videoIds of every reelWatchEndpoint in `obj`, in order, once each."""
    ids = []
    for ep in find_all(obj, 'reelWatchEndpoint'):
        if isinstance(ep, dict) and isinstance(ep.get('videoId'), str) and ep['videoId'] not in ids:
            ids.append(ep['videoId'])
    return ids


def find_strings(obj, key):
    return [v for v in find_all(obj, key) if isinstance(v, str)]


def find_all(obj, key):
    """Yield every value stored under `key` anywhere in a JSON tree."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                yield v
            yield from find_all(v, key)
    elif isinstance(obj, list):
        for v in obj:
            yield from find_all(v, key)


def download(video_id, folder):
    params = {'format': FORMAT, 'merge_output_format': 'mp4', 'outtmpl': os.path.join(folder, '%(id)s.%(ext)s')}
    # Logged out first: about 5 s against 14 s logged in (reading Chrome's
    # cookies, and the extra clients yt-dlp asks as a logged-in user). The
    # login is for what refuses that (age gates, bot checks).
    try:
        with ydl(cookies=False, **params) as y:
            info = y.extract_info(short_url(video_id), download=True)
    except yt_dlp.utils.DownloadError as err:
        print(f'download: logged out failed, retrying logged in: {err}', file=sys.stderr)
        with ydl(**params) as y:
            info = y.extract_info(short_url(video_id), download=True)
    return {
        'id': info['id'],
        'title': info.get('title') or '',
        'author': info.get('uploader') or info.get('channel') or '',
        'duration': info.get('duration') or 0,
        'width': info.get('width') or 0,
        'height': info.get('height') or 0,
        'hasAudio': info.get('acodec') not in (None, 'none'),
        'path': info['requested_downloads'][0]['filepath'],
    }


def watched(video_id):
    ydl(mark_watched=True, simulate=True, skip_download=True).extract_info(short_url(video_id), download=False)
    return {'id': video_id}


def like(video_id):
    return rate(video_id, 'like/like')


def unlike(video_id):
    return rate(video_id, 'like/removelike')


def rate(video_id, endpoint):
    # The like button's own endpoint also carries `likeParams`, but the
    # video id alone is enough, and only reel_item_watch hands those out.
    api = Api()
    if not api.logged_in:
        sys.exit(f'{endpoint}: logged out, nothing to like with')
    api.call(endpoint, {'target': {'videoId': video_id}})
    return {'id': video_id}


if __name__ == '__main__':
    main()
