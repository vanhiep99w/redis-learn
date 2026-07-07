#!/usr/bin/env bash
# Install write-docs skill vào ~/.claude/skills/
# Chạy từ bất kỳ repo nào: bash path/to/install.sh

set -e

SKILL_NAME="write-docs"
SKILL_FILE="$(dirname "$0")/${SKILL_NAME}.skill"
DEST_DIR="${HOME}/.claude/skills"

if [ ! -f "$SKILL_FILE" ]; then
  echo "❌ Không tìm thấy ${SKILL_FILE}"
  exit 1
fi

mkdir -p "$DEST_DIR"

# Xóa version cũ nếu có
rm -rf "${DEST_DIR}/${SKILL_NAME}"

# Unzip .skill file (là zip archive)
unzip -q "$SKILL_FILE" -d "$DEST_DIR"

echo "✅ Đã cài skill '${SKILL_NAME}' vào ${DEST_DIR}/${SKILL_NAME}"
echo "   Restart Claude Code để skill có hiệu lực."
