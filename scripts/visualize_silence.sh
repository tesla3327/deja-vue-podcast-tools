#!/bin/bash

# Check if input file was provided
if [ $# -lt 1 ]; then
  echo "Usage: $0 <input_file> [threshold_db] [min_duration]"
  echo "Example: $0 my_video.mp4 -20 1"
  exit 1
fi

INPUT_FILE="$1"
THRESHOLD="${2:--20}" # Default to -20dB if not specified
DURATION="${3:-1}"    # Default to 1 second if not specified
OUTPUT_IMAGE="silence_visualization_${THRESHOLD}dB_${DURATION}s.png"

# Function to display progress bar
show_progress() {
  local current=$1
  local total=$2
  local percent=$((current * 100 / total))
  local progress=$((current * 50 / total))

  printf "\r[%-50s] %d%% " "$(printf '#%.0s' $(seq 1 $progress))" $percent
}

echo "Analyzing silence with threshold ${THRESHOLD}dB and minimum duration ${DURATION}s"

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

# Move the temporary silence data to the final file
mv silence_data_temp.txt silence_data.txt

# Get the silence data
SILENCE_DATA=$(cat silence_data.txt)

# Extract only the end times for chapter markers
SILENCE_ENDS=$(echo "$SILENCE_DATA" | grep "silence_end" | sed -E 's/.*silence_end: ([0-9.]+).*/\1/')

# Build the filter complex command
echo "Generating visualization..."
FILTER="[0:a]dynaudnorm,showwavespic=s=1920x400:colors=lime[wave];"
FILTER+="color=black:s=1920x400[bg];"
FILTER+="[bg][wave]overlay=format=auto,"
FILTER+="drawbox=y=300:x=0:w=1920:h=3:color=red@0.7:t=fill,"
FILTER+="drawtext=text='Silence Threshold (${THRESHOLD}dB)':fontsize=24:fontcolor=white:x=10:y=270"

# Add markers for each silence end
COUNT=0
for END in $SILENCE_ENDS; do
  X_POS=$(echo "$END * 1920 / $TOTAL_DURATION" | bc -l)
  X_POS=$(echo "$X_POS" | awk '{printf "%.0f", $1}')
  FILTER+=",drawbox=x=$X_POS:y=0:w=3:h=400:color=yellow"
  FILTER+=",drawtext=text='${END}s':x=$(($X_POS+5)):y=20:fontcolor=yellow:fontsize=18"
  COUNT=$((COUNT+1))
done

# Run the visualization
ffmpeg -i "$INPUT_FILE" -filter_complex "$FILTER" -frames:v 1 "$OUTPUT_IMAGE"

echo "Visualization created at $OUTPUT_IMAGE"
echo "Detected ${COUNT} silence points"