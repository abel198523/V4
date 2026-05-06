#!/bin/bash
export PATH="/home/runner/workspace/.pythonlibs/bin:$PATH"
exec gunicorn --bind 0.0.0.0:5000 --reuse-port --config gunicorn.conf.py main:app
