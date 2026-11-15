/**
 *
 *  Copyright 2016 Netflix, Inc.
 *
 *     Licensed under the Apache License, Version 2.0 (the "License");
 *     you may not use this file except in compliance with the License.
 *     You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 *     Unless required by applicable law or agreed to in writing, software
 *     distributed under the License is distributed on an "AS IS" BASIS,
 *     WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *     See the License for the specific language governing permissions and
 *     limitations under the License.
 *
 */

const NO_OUTPUT_SUFFIX = ' No output file was produced.';

/**
 * Error type for every failure surfaced by {@link Vizceral#exportVideo}.
 *
 * The stable `code` property allows callers to branch on the failure reason
 * without parsing the human-readable `message`.
 *
 * @property {string} code One of:
 *   `INVALID_OPTIONS`, `NO_DATA`, `ENCODER_UNAVAILABLE`,
 *   `ENCODER_FAILED`, `EXPORT_IN_PROGRESS`, `CANCELLED`.
 */
class VideoExportError extends Error {
  constructor (code, message) {
    super(message);
    this.name = 'VideoExportError';
    this.code = code;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, VideoExportError);
    }
  }
}

VideoExportError.NO_OUTPUT_SUFFIX = NO_OUTPUT_SUFFIX;

export default VideoExportError;
