"""Convert a PDF to Markdown with Microsoft's MarkItDown.

Runs inside .venv-markitdown (MarkItDown needs Python 3.10+), started by serve.py:
the PDF arrives on stdin and the Markdown is written to stdout as UTF-8.
"""

import io
import sys

from markitdown import MarkItDown, StreamInfo


def main():
    data = sys.stdin.buffer.read()
    result = MarkItDown(enable_plugins=False).convert_stream(
        io.BytesIO(data), stream_info=StreamInfo(extension=".pdf", mimetype="application/pdf")
    )
    sys.stdout.buffer.write(result.markdown.encode("utf-8"))


if __name__ == "__main__":
    main()
