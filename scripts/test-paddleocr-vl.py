r"""Submit a local image to the PaddleOCR AI Studio API and print the result.

Usage (PowerShell):
    $env:PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN = "<your-token>"
    python scripts/test-paddleocr-vl.py --file "C:\path\to\image.png"

The access token is intentionally read from an environment variable instead of
being stored in this file or passed on the command line.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import requests


DEFAULT_JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
DEFAULT_MODEL = "PaddleOCR-VL-1.6"
DEFAULT_TOKEN_ENV = "PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True, type=Path, help="要识别的本地图片或 PDF")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--job-url", default=DEFAULT_JOB_URL)
    parser.add_argument("--token-env", default=DEFAULT_TOKEN_ENV)
    parser.add_argument("--poll-seconds", type=float, default=5.0)
    parser.add_argument("--timeout-seconds", type=float, default=1800.0)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("tmp/paddleocr-vl-output"),
        help="保存 JSONL 和 Markdown 结果的目录",
    )
    return parser.parse_args()


def response_json(response: requests.Response, operation: str) -> dict[str, Any]:
    if not 200 <= response.status_code < 300:
        detail = response.text[:2000].replace("\n", " ")
        raise RuntimeError(f"{operation}失败：HTTP {response.status_code}，响应：{detail}")
    try:
        value = response.json()
    except ValueError as exc:
        raise RuntimeError(f"{operation}失败：服务端没有返回 JSON：{response.text[:500]}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"{operation}失败：响应顶层不是 JSON 对象")
    return value


def submit_job(session: requests.Session, args: argparse.Namespace, token: str) -> str:
    file_path = args.file.expanduser().resolve()
    if not file_path.is_file():
        raise FileNotFoundError(f"文件不存在：{file_path}")

    headers = {"Authorization": f"bearer {token}"}
    optional_payload = {
        "useDocOrientationClassify": False,
        "useDocUnwarping": False,
        "useChartRecognition": False,
    }
    data = {
        "model": args.model,
        "optionalPayload": json.dumps(optional_payload, ensure_ascii=False),
    }

    print(f"提交文件：{file_path}")
    with file_path.open("rb") as file_handle:
        response = session.post(
            args.job_url,
            headers=headers,
            data=data,
            files={"file": (file_path.name, file_handle)},
            timeout=60,
        )
    body = response_json(response, "提交 OCR 任务")
    job_id = body.get("data", {}).get("jobId")
    if not isinstance(job_id, str) or not job_id:
        raise RuntimeError(f"提交成功但响应中没有 data.jobId：{json.dumps(body, ensure_ascii=False)[:2000]}")
    print(f"任务提交成功：{job_id}")
    return job_id


def poll_job(
    session: requests.Session,
    args: argparse.Namespace,
    token: str,
    job_id: str,
) -> str:
    headers = {"Authorization": f"bearer {token}"}
    deadline = time.monotonic() + args.timeout_seconds
    last_state: str | None = None

    while time.monotonic() < deadline:
        response = session.get(f"{args.job_url.rstrip('/')}/{job_id}", headers=headers, timeout=60)
        body = response_json(response, "查询 OCR 任务")
        data = body.get("data")
        if not isinstance(data, dict):
            raise RuntimeError(f"查询成功但响应中没有 data：{json.dumps(body, ensure_ascii=False)[:2000]}")

        state = data.get("state")
        if state != last_state:
            print(f"任务状态：{state}")
            last_state = state

        progress = data.get("extractProgress")
        if isinstance(progress, dict) and state == "running":
            total = progress.get("totalPages")
            extracted = progress.get("extractedPages")
            if total is not None or extracted is not None:
                print(f"提取进度：{extracted}/{total} 页")

        if state == "done":
            result_url = data.get("resultUrl", {}).get("jsonUrl")
            if not isinstance(result_url, str) or not result_url:
                raise RuntimeError(f"任务完成但响应中没有 data.resultUrl.jsonUrl：{json.dumps(data, ensure_ascii=False)[:2000]}")
            return result_url
        if state == "failed":
            raise RuntimeError(f"OCR 任务失败：{data.get('errorMsg', '服务端未提供错误信息')}")

        time.sleep(args.poll_seconds)

    raise TimeoutError(f"轮询超过 {args.timeout_seconds:g} 秒，任务仍未完成：{job_id}")


def save_results(session: requests.Session, args: argparse.Namespace, jsonl_url: str) -> None:
    response = session.get(jsonl_url, timeout=120)
    if not 200 <= response.status_code < 300:
        raise RuntimeError(f"下载 JSONL 结果失败：HTTP {response.status_code}，响应：{response.text[:500]}")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    raw_path = args.output_dir / "result.jsonl"
    raw_path.write_bytes(response.content)
    print(f"JSONL 已保存：{raw_path.resolve()}")

    page_num = 0
    for line in response.text.splitlines():
        if not line.strip():
            continue
        line_body = json.loads(line)
        result = line_body.get("result", {})
        layout_results = result.get("layoutParsingResults", [])
        if not isinstance(layout_results, list):
            continue
        for layout_result in layout_results:
            markdown = layout_result.get("markdown", {})
            text = markdown.get("text", "") if isinstance(markdown, dict) else ""
            md_path = args.output_dir / f"doc_{page_num}.md"
            md_path.write_text(str(text), encoding="utf-8")
            print(f"Markdown 已保存：{md_path.resolve()}")
            print("--- OCR Markdown ---")
            print(str(text).strip())
            print("--- end ---")
            page_num += 1

    if page_num == 0:
        print("警告：结果 JSONL 中没有找到 layoutParsingResults。")


def main() -> int:
    args = parse_args()
    token = os.environ.get(args.token_env, "").strip()
    if not token:
        print(f"缺少访问令牌，请先设置环境变量：{args.token_env}", file=sys.stderr)
        return 2

    try:
        with requests.Session() as session:
            job_id = submit_job(session, args, token)
            jsonl_url = poll_job(session, args, token, job_id)
            save_results(session, args, jsonl_url)
    except (OSError, requests.RequestException, RuntimeError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"测试失败：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
