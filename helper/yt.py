"""cc-shorts YouTube helper: the Shorts feed, downloads and watch history.

    yt.py feed       stdin {"token": str | null, "seen": [videoId], "want": int}
                     prints {"ids": [videoId], "token": str | null,
                             "source": "sequence" | "home" | "subscriptions",
                             "loggedIn": bool}
    yt.py download ID DIR
                     downloads the Short into DIR/ID.mp4 and prints
                     {"id", "title", "author", "duration", "width", "height",
                      "hasAudio", "path"}
    yt.py watched ID marks the Short watched in the account's history

Every command prints one JSON line on stdout; errors go to stderr with a
non-zero exit.

`feed` scrolls the logged-in Shorts sequence: `token` is the
reel_watch_sequence continuation of the last call; pass it back to keep
scrolling. A missing or dead token starts over from the home page's Shorts
shelf; when the sequence API gives nothing at all, the subscriptions Shorts
feed is the fallback (and the token comes back null).

Cookies come from Chrome through yt-dlp. Run with the Python of the
pipx-installed yt-dlp (the system python3 has no yt_dlp):
    ~/.local/pipx/venvs/yt-dlp/bin/python helper/yt.py feed <<< '{"want": 10}'
"""

import json
import os
import sys

import yt_dlp
import yt_dlp.cookies

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


def ydl(cookies=True, **params):
    base = {'quiet': True, 'no_warnings': True, 'noprogress': True}
    if cookies:
        base['cookiesfrombrowser'] = ('chrome',)
    return yt_dlp.YoutubeDL({**base, **params})


def short_url(video_id):
    return f'https://www.youtube.com/shorts/{video_id}'


def main():
    cmd, args = sys.argv[1], sys.argv[2:]
    out = {'feed': feed, 'download': download, 'watched': watched}[cmd](*args)
    json.dump(out, sys.stdout)
    print()


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
        source, token = 'subscriptions', None
        f.from_subscriptions()
    return {'ids': f.ids, 'token': token, 'source': source, 'loggedIn': f.logged_in}


class Feed:
    def __init__(self, seen, want):
        self.seen = seen
        self.want = want
        self.ids = []
        self.ie = ydl().get_info_extractor('YoutubeTab')
        self.page = self.ie._download_webpage(HOME, 'home', note=False)
        self.ytcfg = self.ie.extract_ytcfg('home', self.page)
        self.logged_in = bool(self.ytcfg.get('LOGGED_IN'))

    def scroll(self, token):
        """Pull sequence batches from `token`; returns the token after the last."""
        for _ in range(MAX_BATCHES):
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

    def call(self, endpoint, body):
        return self.ie._call_api(
            endpoint,
            body,
            'feed',
            note=False,
            context=self.ytcfg.get('INNERTUBE_CONTEXT'),
            headers=self.ie.generate_api_headers(ytcfg=self.ytcfg),
        )

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


if __name__ == '__main__':
    main()
