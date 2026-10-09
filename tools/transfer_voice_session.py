#!/usr/bin/env python3
"""Download a completed Project X voice session, verify it, then request Render deletion."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import re
import subprocess
import sys
import wave
import tempfile
import urllib.error
import urllib.request
from pathlib import Path


def request(url: str, token: str, *, method: str = "GET", payload: dict | None = None) -> tuple[bytes, dict[str, str]]:
    data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            return response.read(), {k.lower(): v for k, v in response.headers.items()}
    except urllib.error.HTTPError as exc:
        message = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(message).get("error", message)
        except Exception:
            detail = message
        raise RuntimeError(f"Server returned HTTP {exc.code}: {detail}") from exc


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_component(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", str(value))
    if not cleaned or cleaned in {".", ".."}:
        raise RuntimeError("The session contains an unsafe local folder name.")
    return cleaned[:100]


def combine_for_listening(output_dir: Path, clip_entries: list[tuple[dict, Path]]) -> str | None:
    # The birthday outro is never part of the training/listening assembly.
    clip_entries = [(clip, filename) for clip, filename in clip_entries
                    if 1 <= clip["section"] <= 8 and clip.get("excluded_from_training") is not True]
    ffmpeg = shutil_which("ffmpeg")
    if not ffmpeg or not clip_entries:
        return None
    list_path = output_dir / "_ffmpeg_concat_list.txt"
    combined = output_dir / "Listening_Copy.wav"
    try:
        lines = []
        for _, clip_path in sorted(clip_entries, key=lambda pair: (pair[0]["section"], pair[0]["take"])):
            escaped = clip_path.resolve().as_posix().replace("'", "'\\''")
            lines.append(f"file '{escaped}'")
        list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        result = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
             "-i", str(list_path), "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(combined)],
            capture_output=True, text=True, timeout=900, check=False,
        )
        if result.returncode == 0 and combined.exists() and combined.stat().st_size:
            return combined.name
        combined.unlink(missing_ok=True)
        return None
    except (OSError, subprocess.SubprocessError):
        combined.unlink(missing_ok=True)
        return None
    finally:
        list_path.unlink(missing_ok=True)


def shutil_which(name: str) -> str | None:
    # Keep the transfer utility standard-library-only.
    from shutil import which
    return which(name)


def resolve_message_ffmpeg(destination: Path, override: str | None = None) -> str:
    if override:
        if not Path(override).is_file():
            raise RuntimeError("Configured FFmpeg executable was not found.")
        return override
    config_path = destination.parent / "Config" / "PX_Config.json"
    if config_path.is_file():
        config = json.loads(config_path.read_text(encoding="utf-8-sig"))
        configured = config.get("ffmpeg")
        if isinstance(configured, str) and Path(configured).is_file():
            return configured
    executable = shutil_which("ffmpeg")
    if not executable:
        raise RuntimeError("Special-message WAV conversion requires FFmpeg; no Render deletion requested.")
    return executable


def read_message_pcm(path: Path) -> tuple[bytes, float]:
    with wave.open(str(path), "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 48000, "NONE"):
            raise RuntimeError("Special-message WAV must be mono 48 kHz PCM-16.")
        frames = audio.getnframes()
        pcm = audio.readframes(frames)
        if not frames or len(pcm) != frames * 2:
            raise RuntimeError("Special-message WAV is empty or incomplete.")
        duration = frames / 48000
        if duration > 8.25:
            raise RuntimeError("Special message exceeds PXM-020's 8.25-second capture limit; no Render deletion requested.")
        return pcm, duration


def convert_special_messages(output_dir: Path, clip_entries: list[tuple[dict, Path]],
                             destination: Path, ffmpeg_override: str | None = None) -> list[dict]:
    messages = [(clip, source) for clip, source in clip_entries if clip["section"] == 9]
    if not messages:
        return []
    ffmpeg = resolve_message_ffmpeg(destination, ffmpeg_override)
    converted = []
    for clip, source in messages:
        target = source.parent / ("Message.wav" if len(messages) == 1 else f"Take_{clip['take']:02d}_Message.wav")
        with tempfile.TemporaryDirectory(prefix="_message_conversion_", dir=source.parent) as temp:
            pending = Path(temp) / "Message.wav"
            result = subprocess.run(
                [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-i", str(source),
                 "-vn", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", str(pending)],
                capture_output=True, text=True, timeout=180, check=False)
            if result.returncode != 0:
                raise RuntimeError("Special-message conversion failed; no Render deletion requested. " + result.stderr[:1000])
            pcm, duration = read_message_pcm(pending)
            if target.exists():
                existing_pcm, _ = read_message_pcm(target)
                if existing_pcm != pcm:
                    raise RuntimeError(f"Different message WAV already exists: {target}; no overwrite or Render deletion requested.")
            else:
                os.replace(pending, target)
            converted.append({
                "clip_id": clip["clip_id"], "source_sha256": clip["sha256"],
                "relative_path": target.relative_to(output_dir).as_posix(),
                "sha256": digest(target.read_bytes()), "duration_seconds": duration,
                "excluded_from_training": True, "six_second_edit_completed": False,
                "processing_module": "PXM-020"})
    return converted


def transfer(base_url: str, session_id: str, destination: Path, token: str, ffmpeg_override: str | None = None) -> Path:
    base_url = base_url.rstrip("/")
    session_id = safe_component(session_id)
    endpoint = f"{base_url}/api/transfer/sessions/{session_id}"
    raw, _ = request(endpoint, token)
    envelope = json.loads(raw)
    manifest = envelope["manifest"]
    manifest_hash = envelope["manifest_sha256"]
    if manifest.get("session_id") != session_id:
        raise RuntimeError("The server returned a different session ID.")
    if manifest.get("status") != "READY_FOR_TRANSFER":
        raise RuntimeError(f"Session status is {manifest.get('status')}; it must be READY_FOR_TRANSFER.")

    profile_id = safe_component(envelope.get("profile_id", ""))
    program = manifest.get("program", "CUSTOMER")
    if program == "LIMITED_HELPER_PILOT":
        output_dir = destination / "Pilot_Testers" / profile_id / session_id
    elif program == "CUSTOMER":
        output_dir = destination / profile_id / session_id
    else:
        raise RuntimeError("The session has an unknown program label; no files were written.")
    output_dir.mkdir(parents=True, exist_ok=True)

    local_manifest_path = output_dir / "Session_Manifest.json"
    local_manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    clip_entries: list[tuple[dict, Path]] = []
    verified = []
    clips = sorted(
        ([clip for section in manifest.get("sections", {}).values() for clip in section.get("takes", [])]
         + manifest.get("special_message", {}).get("takes", [])),
        key=lambda clip: (int(clip["section"]), int(clip["take"])),
    )
    if not clips:
        raise RuntimeError("The session manifest contains no recordings.")

    seen_ids, seen_slots = set(), set()
    for clip in clips:
        section, take = clip.get("section"), clip.get("take")
        if type(section) is not int or section not in range(1, 10) or type(take) is not int or take < 1:
            raise RuntimeError("Invalid section/take identity; no Render deletion requested.")
        clip_id = clip.get("clip_id", "")
        if not isinstance(clip_id, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", clip_id) or clip_id in seen_ids:
            raise RuntimeError("Missing or duplicate clip identity; no Render deletion requested.")
        if (section, take) in seen_slots:
            raise RuntimeError("Duplicate local take destination; no Render deletion requested.")
        seen_ids.add(clip_id); seen_slots.add((section, take))
        if section == 9 and clip not in manifest.get("special_message", {}).get("takes", []):
            raise RuntimeError("Special message is not stored separately in the manifest.")
        if section != 9 and clip in manifest.get("special_message", {}).get("takes", []):
            raise RuntimeError("Special message has an invalid section identity.")
        if type(clip.get("bytes")) is not int or clip["bytes"] <= 0 or not re.fullmatch(r"[0-9a-f]{64}", str(clip.get("sha256", ""))):
            raise RuntimeError("Invalid clip size or hash; no Render deletion requested.")
        if Path(str(clip.get("file_name", ""))).suffix.lower() not in {".wav", ".webm", ".m4a", ".ogg", ".mp4"}:
            raise RuntimeError("Unsupported clip extension; no Render deletion requested.")

    for clip in clips:
        section_number = int(clip["section"])
        take_number = int(clip["take"])
        filename = Path(str(clip["file_name"])).name
        section_dir = output_dir / ("Special_Message" if section_number == 9 else f"Section_{section_number:02d}")
        section_dir.mkdir(parents=True, exist_ok=True)
        local_path = section_dir / f"Take_{take_number:02d}{Path(filename).suffix.lower()}"
        clip_url = f"{endpoint}/clips/{clip['clip_id']}"
        audio, headers = request(clip_url, token)
        actual_hash = digest(audio)
        if len(audio) != int(clip["bytes"]) or actual_hash != clip["sha256"]:
            raise RuntimeError(f"Download verification failed for section {section_number}, take {take_number}; Render audio was not deleted.")
        advertised_hash = headers.get("x-content-sha256")
        if advertised_hash and advertised_hash != actual_hash:
            raise RuntimeError(f"Server hash header mismatch for section {section_number}, take {take_number}; Render audio was not deleted.")
        if local_path.exists():
            if digest(local_path.read_bytes()) != actual_hash:
                raise RuntimeError(f"A different local file already exists at {local_path}; it was not overwritten and Render audio was not deleted.")
        else:
            temp_path = local_path.with_suffix(local_path.suffix + ".part")
            temp_path.write_bytes(audio)
            if digest(temp_path.read_bytes()) != actual_hash:
                temp_path.unlink(missing_ok=True)
                raise RuntimeError(f"Local disk verification failed for {local_path}; Render audio was not deleted.")
            os.replace(temp_path, local_path)
        verified.append({"clip_id": clip["clip_id"], "sha256": actual_hash})
        clip_entries.append((clip, local_path))
        print(f"Verified section {section_number}, take {take_number}: {local_path.name}")

    message_wavs = convert_special_messages(output_dir, clip_entries, destination, ffmpeg_override)
    combined_name = combine_for_listening(output_dir, clip_entries)
    report = {
        "schema_version": "PX-TIER1-LOCAL-TRANSFER-1.2.0",
        "program": program,
        "session_id": session_id,
        "profile_id": profile_id,
        "manifest_sha256": manifest_hash,
        "verified_at_local": __import__("datetime").datetime.now().astimezone().isoformat(),
        "verified_clips": verified,
        "listening_copy": combined_name,
        "special_message_excluded_from_training": True,
        "special_message_files": [
            {"clip_id": clip["clip_id"], "relative_path": filename.relative_to(output_dir).as_posix(),
             "sha256": clip["sha256"], "purpose": "BIRTHDAY_OUTRO", "capture_seconds": 8,
             "finished_seconds": 6, "six_second_edit_completed": False}
            for clip, filename in clip_entries if clip["section"] == 9
        ],
        "special_message_wavs": message_wavs,
        "message_wav": str(output_dir / message_wavs[0]["relative_path"]) if len(message_wavs) == 1 else "",
        "message_selection_required": len(message_wavs) > 1,
        "render_audio_delete_requested": False,
    }
    report_path = output_dir / "Transfer_Verification.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    # Re-open every local copy immediately before requesting deletion.
    for clip, local_path in clip_entries:
        if digest(local_path.read_bytes()) != clip["sha256"]:
            raise RuntimeError(f"Final local verification failed for {local_path}; Render audio was not deleted.")

    for message in message_wavs:
        local_wav = output_dir / message["relative_path"]
        read_message_pcm(local_wav)
        if digest(local_wav.read_bytes()) != message["sha256"]:
            raise RuntimeError("Message WAV changed before confirmation; no Render deletion requested.")

    payload = {"manifest_sha256": manifest_hash, "files": verified}
    receipt_bytes, _ = request(f"{endpoint}/confirm", token, method="POST", payload=payload)
    receipt = json.loads(receipt_bytes)
    if receipt.get("status") != "TRANSFERRED_AUDIO_DELETED":
        raise RuntimeError("The server did not confirm Render audio deletion.")
    manifest["status"] = receipt["status"]
    manifest["transferred_at"] = receipt.get("transferred_at")
    manifest["transfer"] = {
        "manifest_sha256_before_transfer": manifest_hash,
        "verified_clip_count": len(verified),
        "local_verification_report": report_path.name,
    }
    local_manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    report["render_audio_delete_requested"] = True
    report["render_receipt"] = receipt
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Transfer verified. Render deleted {receipt.get('deleted_clip_count')} audio clips.")
    for clip, filename in clip_entries:
        if clip["section"] == 9:
            print(f"Separate birthday message: {filename} (original capture; six-second edit pending)")
    for message in message_wavs:
        print(f"Message WAV ready for PXM-020: {output_dir / message['relative_path']}")
    if len(message_wavs) > 1:
        print("Multiple message takes retained; choose one before production.")
    if combined_name:
        print(f"Listening copy created: {output_dir / combined_name}")
    else:
        print("Individual clips were transferred. A combined listening WAV was skipped (ffmpeg unavailable or conversion failed).")
    return output_dir


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session_id", help="Session ID shown in the capture page")
    parser.add_argument("--url", default="https://sdp-backend-6xt6.onrender.com", help="Render service base URL")
    default_destination = Path("D:/Working/Project_X/PX_Engine/Voices") if os.name == "nt" else Path.home() / "PX_Engine_Voices"
    parser.add_argument("--destination", type=Path, default=default_destination, help="Local master-library root")
    parser.add_argument("--ffmpeg", help="Optional FFmpeg executable path; otherwise PX Engine config or PATH is used")
    args = parser.parse_args()
    token = os.environ.get("VOICE_TRANSFER_TOKEN") or getpass.getpass("Render transfer token: ")
    if len(token.encode("utf-8")) < 32:
        print("Transfer token must contain at least 32 characters.", file=sys.stderr)
        return 2
    try:
        output = transfer(args.url, args.session_id, args.destination.expanduser().resolve(), token, args.ffmpeg)
    except Exception as exc:
        print(f"Transfer stopped: {exc}", file=sys.stderr)
        print("Render audio was not deleted unless the server explicitly reported a completed transfer.", file=sys.stderr)
        return 1
    print(f"Local master folder: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
