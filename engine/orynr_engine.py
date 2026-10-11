"""Start the compiled Orynr Code engine (needs Python 3.11, 64-bit, and `pip install -r requirements.txt`).
Put orynr_server.cp311-win_amd64.pyd and orynr_skills.bin from the release zip next to this file."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from orynr_server.__main__ import main  # noqa: E402

sys.exit(main())
