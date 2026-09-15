#!/usr/bin/env python3
# Copied from the user's original modem_download.py (yt-dlp based downloader
# for Bandcamp/SoundCloud picks). Logic is preserved as-is — same yt-dlp
# options, cover-art embedding via ffmpeg, filename/folder conventions,
# already-downloaded checks — plus two additive, backwards-compatible changes
# for the show-builder tool that drives this script:
#   1. sanitize_filename() also strips <>"|?* (Windows-illegal, previously
#      only :/\ were stripped — a latent crash waiting to happen).
#   2. Each processed URL appends one JSON record to data/download-manifest.jsonl
#      so show-builder/server.js can learn which local file(s) resulted from
#      which source URL (the original script only ever printed to stdout).
import os
import sys
import copy
import json
import shutil
import subprocess
import requests
from yt_dlp import YoutubeDL

# When this script's stdout/stderr are piped (as server.js does via spawn(),
# rather than a real console), Python falls back to the system codepage
# (e.g. cp1252 on Windows), which can't encode characters yt-dlp's own
# filename sanitization introduces (e.g. U+FF1A "：" for ":") — any print()
# of such a title then crashes the whole run. Force UTF-8 unconditionally so
# piped and interactive runs behave the same.
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

#########################################
# HELPER FUNCTIONS
#########################################

def sanitize_filename(name):
    """Remove characters that may not be allowed in folder/file names."""
    for ch in [":", "/", "\\", "<", ">", '"', "|", "?", "*"]:
        name = name.replace(ch, "_")
    return name.strip()

def album_folder_name(info, url):
    """
    Construct a folder name for an album.
    - For SoundCloud URLs, use uploader as artist.
    - For others (e.g. Bandcamp), try info['artist'] or use first entry's artist.
    Returns a tuple: (album_folder_path, album_artist)
    """
    if url.startswith("https://soundcloud.com/"):
        album_artist = info.get('uploader') or "UnknownArtist"
        album_title = info.get('playlist_title') or info.get('title') or "Album"
    else:
        album_artist = info.get('artist')
        if not album_artist and info.get('entries'):
            first_entry = info['entries'][0]
            album_artist = first_entry.get('artist')
        if not album_artist:
            album_artist = "UnknownArtist"
        album_title = info.get('playlist_title') or info.get('title') or "Album"
    folder = f"{album_artist} - {album_title}"
    return os.path.join("downloads", sanitize_filename(folder)), album_artist

def single_outtmpl():
    """Output template for single track downloads (only track title in filename)."""
    return os.path.join("downloads", "%(title)s.%(ext)s")

def album_outtmpl(album_dir):
    """Output template for album tracks (only track title in filename)."""
    return os.path.join(album_dir, "%(title)s.%(ext)s")

def fetch_album_cover_from_url(cover_url, album_dir):
    """
    Download the album cover from cover_url and save it as cover.jpg in album_dir.
    """
    cover_path = os.path.join(album_dir, "cover.jpg")
    try:
        print(f"Attempting to download album cover from URL: {cover_url}")
        r = requests.get(cover_url, timeout=15)
        r.raise_for_status()
        with open(cover_path, "wb") as f:
            f.write(r.content)
        print(f"Album cover saved as: {cover_path}")
    except Exception as e:
        print(f"Error downloading cover from metadata URL: {e}", file=sys.stderr)

def consolidate_album_images(album_dir):
    """
    Look in album_dir for any .jpg files (other than cover.jpg). If found,
    copy the first one as cover.jpg and remove extra jpg files.
    """
    jpg_files = [f for f in os.listdir(album_dir) if f.lower().endswith('.jpg')]
    cover_path = os.path.join(album_dir, "cover.jpg")
    if jpg_files:
        if not os.path.exists(cover_path):
            first_img = os.path.join(album_dir, jpg_files[0])
            try:
                shutil.copy2(first_img, cover_path)
                print(f"Set album cover for folder '{album_dir}' as cover.jpg using {jpg_files[0]}")
            except Exception as e:
                print(f"Error copying {jpg_files[0]} as cover: {e}", file=sys.stderr)
        for f in jpg_files:
            if f.lower() != "cover.jpg":
                fp = os.path.join(album_dir, f)
                try:
                    os.remove(fp)
                    print(f"Removed extra thumbnail file: {fp}")
                except Exception as e:
                    print(f"Error removing {fp}: {e}", file=sys.stderr)
    else:
        print("No JPEG files found to consolidate as album cover.", file=sys.stderr)

def copy_album_cover_to_global(album_dir):
    """
    Copy the album cover (cover.jpg) from album_dir to the global _covers folder in downloads.
    The cover is renamed as "<album_folder>_cover.jpg".
    """
    cover_src = os.path.join(album_dir, "cover.jpg")
    if not os.path.exists(cover_src):
        print(f"No cover.jpg found in {album_dir} to copy to _covers.", file=sys.stderr)
        return None
    covers_dir = os.path.join("downloads", "_covers")
    os.makedirs(covers_dir, exist_ok=True)
    album_folder_basename = os.path.basename(album_dir)
    dest_filename = f"{album_folder_basename}_cover.jpg"
    cover_dest = os.path.join(covers_dir, dest_filename)
    try:
        shutil.copy2(cover_src, cover_dest)
        print(f"Copied album cover to global folder as: {cover_dest}")
        return cover_dest
    except Exception as e:
        print(f"Error copying album cover to global folder: {e}", file=sys.stderr)
        return None

def remove_embed_thumbnail(postprocessors):
    """Return a postprocessor list without the FFmpegEmbedThumbnail entry."""
    return [pp for pp in postprocessors if pp.get('key') != 'FFmpegEmbedThumbnail']

def embed_cover_in_album(album_dir):
    """
    For every MP3 file in album_dir (excluding cover.jpg and temporary files),
    embed cover.jpg into the file using FFmpeg.
    """
    cover_path = os.path.join(album_dir, "cover.jpg")
    if not os.path.exists(cover_path):
        print(f"No cover.jpg found in {album_dir}. Cannot embed cover.", file=sys.stderr)
        return
    for filename in os.listdir(album_dir):
        if filename.lower().endswith(".mp3"):
            if "temp" in filename.lower():
                continue
            file_path = os.path.join(album_dir, filename)
            temp_file = file_path + ".temp.mp3"
            cmd = [
                "ffmpeg", "-y",
                "-i", file_path,
                "-i", cover_path,
                "-map", "0", "-map", "1",
                "-c", "copy",
                "-id3v2_version", "3",
                temp_file
            ]
            print(f"Embedding cover into {filename} ...")
            try:
                subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                os.replace(temp_file, file_path)
                print(f"Cover embedded into {filename}")
            except subprocess.CalledProcessError as e:
                print(f"Error embedding cover into {filename}: {e.stderr.decode('utf-8')}", file=sys.stderr)
                if os.path.exists(temp_file):
                    os.remove(temp_file)

def embed_cover_single(file_path, cover_url):
    """
    For a single track, download the cover image from cover_url, embed it into the file,
    and also copy the cover image to the global _covers folder.
    """
    cover_temp = file_path + ".cover.jpg"
    try:
        print(f"Downloading single track cover image from {cover_url} ...")
        r = requests.get(cover_url, timeout=15)
        r.raise_for_status()
        with open(cover_temp, "wb") as f:
            f.write(r.content)
        print(f"Downloaded single cover image to {cover_temp}")
    except Exception as e:
        print(f"Error downloading cover image for single track: {e}", file=sys.stderr)
        return None
    temp_file = file_path + ".temp.mp3"
    cmd = [
        "ffmpeg", "-y",
        "-i", file_path,
        "-i", cover_temp,
        "-map", "0", "-map", "1",
        "-c", "copy",
        "-id3v2_version", "3",
        temp_file
    ]
    print(f"Embedding cover image into single track file {file_path} ...")
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        os.replace(temp_file, file_path)
        print(f"Cover embedded into single track: {file_path}")
    except subprocess.CalledProcessError as e:
        print(f"Error embedding cover into single track {file_path}: {e.stderr.decode('utf-8')}", file=sys.stderr)
        if os.path.exists(temp_file):
            os.remove(temp_file)
    # Copy the downloaded cover to global _covers folder.
    covers_dir = os.path.join("downloads", "_covers")
    os.makedirs(covers_dir, exist_ok=True)
    track_title = os.path.splitext(os.path.basename(file_path))[0]
    dest_cover = os.path.join(covers_dir, f"{sanitize_filename(track_title)}_cover.jpg")
    try:
        shutil.copy2(cover_temp, dest_cover)
        print(f"Copied single track cover to global folder as: {dest_cover}")
    except Exception as e:
        print(f"Error copying single track cover to global folder: {e}", file=sys.stderr)
        dest_cover = None
    if os.path.exists(cover_temp):
        os.remove(cover_temp)
    return dest_cover

def strip_artist_prefix(album_dir):
    """
    Rename all MP3 files in album_dir that contain a dash variant so that only the track title remains.
    For every file, if it contains any of the dash variants (" - ", " – ", "—"),
    rename it to only the substring after the first such occurrence.
    """
    dash_variants = [" - ", " – ", "—"]
    for filename in os.listdir(album_dir):
        if filename.lower().endswith(".mp3"):
            new_name = filename
            for dash in dash_variants:
                if dash in new_name:
                    new_name = new_name.split(dash, 1)[1].strip()
                    break
            if new_name != filename:
                old_path = os.path.join(album_dir, filename)
                new_path = os.path.join(album_dir, new_name)
                try:
                    os.rename(old_path, new_path)
                    print(f"Renamed '{filename}' to '{new_name}'")
                except Exception as e:
                    print(f"Error renaming file {filename}: {e}", file=sys.stderr)

#########################################
# MANIFEST (new — lets show-builder/server.js learn which local file(s)
# resulted from which source URL; the original script only printed to stdout)
#########################################

MANIFEST_PATH = os.path.join("data", "download-manifest.jsonl")

def append_manifest(record):
    os.makedirs("data", exist_ok=True)
    with open(MANIFEST_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

#########################################
# METADATA EXTRACTION AND DOWNLOAD LOGIC
#########################################

BASE_OPTS = {
    'format': 'bestaudio/best',
    'convert_thumbnails': 'jpg',
    'ignoreerrors': True,
    'addmetadata': True,
    'quiet': False,
    'verbose': True,
    'http_headers': {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-us,en;q=0.5',
    },
}

def extract_info_no_download(url):
    """
    Use yt-dlp in simulate mode to determine if the URL is a single track or a playlist.
    Returns (entry_type, info_dict)
    """
    tmp_opts = copy.deepcopy(BASE_OPTS)
    tmp_opts.update({'simulate': True, 'download': False, 'quiet': True, 'verbose': False})
    try:
        with YoutubeDL(tmp_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        print(f"Error extracting info from {url}: {e}", file=sys.stderr)
        return None, None
    if info.get('entries'):
        return 'playlist', info
    return 'single', info

def expected_output_path(info, outtmpl):
    """
    Ask yt-dlp itself what filename it will use for `info` under `outtmpl`,
    then swap the extension for .mp3 (post audio-extraction).

    yt-dlp's own filename sanitization differs from this script's
    sanitize_filename() — e.g. it turns ":" into the fullwidth "：" rather
    than "_" — so any title containing such a character (common on
    SoundCloud, e.g. "premiere: ...") would make already_downloaded_single()
    and the manual cover-embed step below look for a file that doesn't
    exist. Going through prepare_filename() keeps this in sync with
    whatever yt-dlp actually writes, regardless of version/OS quirks.
    """
    tmp_opts = copy.deepcopy(BASE_OPTS)
    tmp_opts.update({'outtmpl': outtmpl, 'quiet': True, 'verbose': False})
    with YoutubeDL(tmp_opts) as ydl:
        path = ydl.prepare_filename(info)
    return os.path.splitext(path)[0] + '.mp3'

def already_downloaded_single(info):
    """
    Check if a single track has already been downloaded, using yt-dlp's own
    filename sanitization (see expected_output_path) to find it.
    """
    if not info.get("title"):
        return False
    return os.path.exists(expected_output_path(info, single_outtmpl()))

def already_downloaded_playlist(album_dir):
    """
    Check if an album folder exists and contains at least one MP3 file.
    """
    if not os.path.exists(album_dir):
        return False
    for f in os.listdir(album_dir):
        if f.lower().endswith(".mp3"):
            return True
    return False

def download_single(url, info):
    """
    Download a single track. Use writethumbnail for embedding.
    If embedding fails, retry without. Then manually embed the cover.
    """
    track_title = info.get("title", "unknown")
    file_path = expected_output_path(info, single_outtmpl())

    if already_downloaded_single(info):
        print(f"Single track '{info.get('title')}' already downloaded; skipping.")
        # The cover was already copied to _covers on the ORIGINAL download —
        # re-derive its expected path (same naming as embed_cover_single)
        # instead of reporting None, or every re-scan of an already-
        # downloaded track looks cover-less to anything reading the manifest.
        covers_dir = os.path.join("downloads", "_covers")
        cover_name = os.path.splitext(os.path.basename(file_path))[0]
        expected_cover = os.path.join(covers_dir, f"{sanitize_filename(cover_name)}_cover.jpg")
        append_manifest({
            "url": url, "kind": "single", "title": track_title,
            "artist": info.get("uploader") or info.get("artist"),
            "files": [file_path] if os.path.exists(file_path) else [],
            "cover": expected_cover if os.path.exists(expected_cover) else None,
            "skipped": True,
        })
        return
    outtmpl = single_outtmpl()
    postprocessors = [
        {
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192',
        },
        {
            'key': 'FFmpegEmbedThumbnail',
        },
        {
            'key': 'FFmpegMetadata',
        },
    ]
    opts = copy.deepcopy(BASE_OPTS)
    opts.update({
        'outtmpl': outtmpl,
        'writethumbnail': True,
        'postprocessors': postprocessors,
    })
    os.makedirs("downloads", exist_ok=True)
    print(f"Downloading single track: {url}")
    try:
        with YoutubeDL(opts) as ydl:
            ydl.download([url])
    except Exception as e:
        print(f"Error embedding thumbnail for single track {url}: {e}")
        if 'FFmpegEmbedThumbnailPP' in str(e):
            print("Retrying single track download without thumbnail embedding...")
            opts['postprocessors'] = remove_embed_thumbnail(postprocessors)
            try:
                with YoutubeDL(opts) as ydl:
                    ydl.download([url])
            except Exception as e2:
                print(f"Retry failed for {url}: {e2}", file=sys.stderr)
    # Manually embed cover for the single track.
    cover_url = info.get("thumbnail") or info.get("artwork_url")
    cover_dest = None
    if cover_url:
        if os.path.exists(file_path):
            print(f"Manually embedding cover for single track: {file_path}")
            cover_dest = embed_cover_single(file_path, cover_url)
        else:
            print(f"Downloaded single track file not found: {file_path}", file=sys.stderr)
    append_manifest({
        "url": url, "kind": "single", "title": track_title,
        "artist": info.get("uploader") or info.get("artist"),
        "files": [file_path] if os.path.exists(file_path) else [],
        "cover": cover_dest, "skipped": False,
    })

def download_playlist(url, info):
    """
    Download a playlist/album.
    Save tracks in a folder named "Artist - Album" (determined from metadata) with filenames containing only the track title.
    Then obtain (or consolidate) a cover image, embed it in every MP3, strip any redundant artist prefix,
    and copy the cover to the global _covers folder.
    """
    album_dir, album_artist = album_folder_name(info, url)
    album_title = info.get('playlist_title') or info.get('title') or "Album"
    if already_downloaded_playlist(album_dir):
        print(f"Album at '{album_dir}' already downloaded; skipping.")
        files = [os.path.join(album_dir, f) for f in os.listdir(album_dir) if f.lower().endswith(".mp3")] if os.path.exists(album_dir) else []
        # Same fix as download_single's skip path — re-derive the cover's
        # expected path (same naming as copy_album_cover_to_global) instead
        # of always reporting None.
        covers_dir = os.path.join("downloads", "_covers")
        expected_cover = os.path.join(covers_dir, f"{os.path.basename(album_dir)}_cover.jpg")
        append_manifest({
            "url": url, "kind": "playlist", "title": album_title, "artist": album_artist,
            "files": files, "cover": expected_cover if os.path.exists(expected_cover) else None, "skipped": True,
        })
        return
    outtmpl = os.path.join(album_dir, "%(title)s.%(ext)s")
    opts = copy.deepcopy(BASE_OPTS)
    opts.update({
        'writethumbnail': True,
        'outtmpl': outtmpl,
        'postprocessors': [
            {
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '192',
            },
            {
                'key': 'FFmpegMetadata',
            },
        ],
    })
    os.makedirs(album_dir, exist_ok=True)
    print(f"Downloading album/playlist: {url}")
    try:
        with YoutubeDL(opts) as ydl:
            ydl.download([url])
    except Exception as e:
        print(f"Error downloading playlist {url}: {e}", file=sys.stderr)
    # Attempt to get album cover from metadata.
    cover_url = info.get('thumbnail') or info.get('artwork_url') or info.get('playlist_thumbnail')
    if cover_url:
        fetch_album_cover_from_url(cover_url, album_dir)
    else:
        consolidate_album_images(album_dir)
    # Embed cover image into each MP3 file.
    embed_cover_in_album(album_dir)
    # Remove any redundant artist prefix from filenames.
    strip_artist_prefix(album_dir)
    # Copy the album cover to the global _covers folder.
    cover_dest = copy_album_cover_to_global(album_dir)
    files = [os.path.join(album_dir, f) for f in os.listdir(album_dir) if f.lower().endswith(".mp3")] if os.path.exists(album_dir) else []
    append_manifest({
        "url": url, "kind": "playlist", "title": album_title, "artist": album_artist,
        "files": files, "cover": cover_dest, "skipped": False,
    })

def main(input_file):
    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            urls = [line.strip() for line in f if line.strip()]
    except Exception as e:
        print(f"Error reading file {input_file}: {e}", file=sys.stderr)
        sys.exit(1)
    for url in urls:
        entry_type, info = extract_info_no_download(url)
        if entry_type is None:
            append_manifest({"url": url, "kind": None, "title": None, "artist": None, "files": [], "cover": None, "error": "extract_info failed"})
            continue
        if entry_type == 'single':
            download_single(url, info)
        else:
            download_playlist(url, info)

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print("Usage: python modem_download.py <urls_file>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1])
