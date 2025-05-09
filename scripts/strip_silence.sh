#!/bin/bash

# Check if input file was provided
if [ $# -lt 1 ]; then
  echo "Usage: $0 <input_file> [threshold_db] [min_duration] [buffer_ms]"
  echo "Example: $0 my_video.mp4 -20 1 200"
  exit 1
fi

INPUT_FILE="$1"
THRESHOLD="${2:--30}" # Default to -30dB if not specified
DURATION="${3:-1}"    # Default to 1 second if not specified
BUFFER_MS="${4:-200}" # Default to 1000ms if not specified
BUFFER_SEC=$(echo "scale=3; $BUFFER_MS/1000" | bc)
OUTPUT_FILE="${INPUT_FILE%.*}_no_silence.${INPUT_FILE##*.}"

# Function to display progress bar
show_progress() {
  local current=$1
  local total=$2
  local percent=$((current * 100 / total))
  local progress=$((current * 50 / total))

  printf "\r[%-50s] %d%% " "$(printf '#%.0s' $(seq 1 $progress))" $percent
}

echo "Analyzing silence with threshold ${THRESHOLD}dB and minimum duration ${DURATION}s"
echo "Buffer around silence: ${BUFFER_MS}ms"

# Get total duration for scaling
echo "Getting media duration..."
TOTAL_DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE")
TOTAL_DURATION=$(echo "$TOTAL_DURATION" | awk '{print int($1)+1}') # Round up
echo "Total duration: ${TOTAL_DURATION} seconds"

# Create a temporary fifo for progress tracking
PROGRESS_FIFO=$(mktemp -u)
mkfifo "$PROGRESS_FIFO"

# Start processing in background with progress output
echo "Analyzing audio for silence..."
(ffmpeg -i "$INPUT_FILE" -af "silencedetect=n=${THRESHOLD}dB:d=${DURATION}" -f null - \
  -progress "$PROGRESS_FIFO" 2>&1 | grep -E 'silence_(start|end)' > silence_data_temp.txt) &
FFMPEG_PID=$!

# Initialize progress variables
CURRENT_TIME=0

# Read from the progress fifo to update progress bar
while read -r line; do
  if [[ "$line" == out_time_ms* ]]; then
    # Extract current time in milliseconds and convert to seconds
    CURRENT_MS=$(echo "$line" | sed -E 's/out_time_ms=([0-9]+)/\1/')
    CURRENT_TIME=$(echo "scale=2; $CURRENT_MS/1000000" | bc)

    # Update progress bar (ensure CURRENT_TIME doesn't exceed TOTAL_DURATION)
    if (( $(echo "$CURRENT_TIME > $TOTAL_DURATION" | bc -l) )); then
      CURRENT_TIME=$TOTAL_DURATION
    fi
    show_progress ${CURRENT_TIME%.*} $TOTAL_DURATION
  fi
done < "$PROGRESS_FIFO"

# Wait for the background process to finish
wait $FFMPEG_PID
echo -e "\nSilence detection complete!"

# Clean up the fifo
rm "$PROGRESS_FIFO"

# Generate the ffmpeg filter complex for silenceremove with buffer
echo "Creating silence removal filter..."

# Process silence data to create filter
START_TIMES=()
END_TIMES=()

while IFS= read -r line; do
  if [[ "$line" == *silence_start* ]]; then
    start=$(echo "$line" | sed -E 's/.*silence_start: ([0-9.]+).*/\1/')
    # Add buffer to start time (add buffer time to shrink silence)
    start=$(echo "$start + $BUFFER_SEC" | bc)
    START_TIMES+=("$start")
  elif [[ "$line" == *silence_end* ]]; then
    end=$(echo "$line" | sed -E 's/.*silence_end: ([0-9.]+).*/\1/')
    # Subtract buffer from end time (subtract buffer time to shrink silence)
    end=$(echo "$end - $BUFFER_SEC" | bc)
    # Ensure end is not before start (could happen with small silences)
    # This logic will be checked later when building the filter
    END_TIMES+=("$end")
  fi
done < silence_data_temp.txt

# Remove the temporary file
rm silence_data_temp.txt

# Filter out invalid segments (where end <= start)
VALID_START_TIMES=()
VALID_END_TIMES=()

for i in "${!START_TIMES[@]}"; do
  if [ $i -lt ${#END_TIMES[@]} ]; then
    if (( $(echo "${END_TIMES[$i]} > ${START_TIMES[$i]}" | bc -l) )); then
      VALID_START_TIMES+=("${START_TIMES[$i]}")
      VALID_END_TIMES+=("${END_TIMES[$i]}")
    else
      echo "Warning: Silence segment $i was too short after applying buffer. Skipping."
    fi
  fi
done

# Replace the original arrays with the filtered ones
START_TIMES=("${VALID_START_TIMES[@]}")
END_TIMES=("${VALID_END_TIMES[@]}")

# Create trim filter segments
FILTER_COMPLEX=""
CONCAT=""
SEGMENT_COUNT=0

# Always include from beginning to first silence
if [ ${#START_TIMES[@]} -gt 0 ]; then
  FILTER_COMPLEX+="[0:v]trim=start=0:end=${START_TIMES[0]},setpts=PTS-STARTPTS[v0];"
  FILTER_COMPLEX+="[0:a]atrim=start=0:end=${START_TIMES[0]},asetpts=PTS-STARTPTS[a0];"
  CONCAT+="[v0][a0]"
  SEGMENT_COUNT=$((SEGMENT_COUNT + 1))
else
  # No silences found, just copy the file
  echo "No silences detected with current threshold and duration. Copying the original file..."
  cp "$INPUT_FILE" "$OUTPUT_FILE"
  echo "Done! Output saved as $OUTPUT_FILE"
  exit 0
fi

# Add segments between silences
for i in "${!START_TIMES[@]}"; do
  if [ $i -lt $((${#END_TIMES[@]} - 1)) ]; then
    FILTER_COMPLEX+="[0:v]trim=start=${END_TIMES[$i]}:end=${START_TIMES[$i+1]},setpts=PTS-STARTPTS[v$((i+1))];"
    FILTER_COMPLEX+="[0:a]atrim=start=${END_TIMES[$i]}:end=${START_TIMES[$i+1]},asetpts=PTS-STARTPTS[a$((i+1))];"
    CONCAT+="[v$((i+1))][a$((i+1))]"
    SEGMENT_COUNT=$((SEGMENT_COUNT + 1))
  fi
done

# Add the last segment from last silence to end
if [ ${#END_TIMES[@]} -gt 0 ]; then
  LAST_END=${END_TIMES[$((${#END_TIMES[@]} - 1))]}
  FILTER_COMPLEX+="[0:v]trim=start=$LAST_END,setpts=PTS-STARTPTS[vlast];"
  FILTER_COMPLEX+="[0:a]atrim=start=$LAST_END,asetpts=PTS-STARTPTS[alast];"
  CONCAT+="[vlast][alast]"
  SEGMENT_COUNT=$((SEGMENT_COUNT + 1))
fi

# Complete the filter with the concat
FILTER_COMPLEX+="${CONCAT}concat=n=${SEGMENT_COUNT}:v=1:a=1[outv][outa]"

# Create a temporary fifo for progress tracking of final encoding
PROGRESS_FIFO=$(mktemp -u)
mkfifo "$PROGRESS_FIFO"

echo "Removing silence and encoding..."
ffmpeg -i "$INPUT_FILE" -filter_complex "$FILTER_COMPLEX" -map "[outv]" -map "[outa]" \
  -progress "$PROGRESS_FIFO" -c:v libx264 -c:a aac "$OUTPUT_FILE" &
FFMPEG_PID=$!

# Reset progress variables
CURRENT_TIME=0

# Read from the progress fifo to update progress bar
while read -r line; do
  if [[ "$line" == out_time_ms* ]]; then
    # Extract current time in milliseconds and convert to seconds
    CURRENT_MS=$(echo "$line" | sed -E 's/out_time_ms=([0-9]+)/\1/')
    CURRENT_TIME=$(echo "scale=2; $CURRENT_MS/1000000" | bc)

    # Update progress bar
    show_progress ${CURRENT_TIME%.*} $TOTAL_DURATION
  fi
done < "$PROGRESS_FIFO"

# Wait for the background process to finish
wait $FFMPEG_PID
echo -e "\nSilence removal complete!"

# Clean up the fifo
rm "$PROGRESS_FIFO"

echo "Done! Output saved as $OUTPUT_FILE"