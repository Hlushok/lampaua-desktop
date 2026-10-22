#pragma once
#include <napi.h>
#include "d3d11_renderer.h"
#include <atomic>
#include <cmath>
#include <mutex>

namespace lampaua {
inline bool gpu_integer(Napi::Value value, uint64_t& output, uint64_t max) {
  if (!value.IsNumber()) return false;
  double number = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || number < 0 || std::floor(number) != number || number > max) return false;
  output = static_cast<uint64_t>(number);
  return true;
}
inline bool gpu_key(Napi::Value value, GpuFrameKey& key) {
  if (!value.IsObject()) return false;
  auto object = value.As<Napi::Object>();
  uint64_t slot;
  if (!gpu_integer(object.Get("slot"), slot, 2) ||
      !gpu_integer(object.Get("generation"), key.generation, 9007199254740991ULL) || !key.generation ||
      !gpu_integer(object.Get("sequence"), key.sequence, 9007199254740991ULL) || !key.sequence) return false;
  key.slot = static_cast<uint32_t>(slot);
  return true;
}
inline Napi::Object gpu_frame(Napi::Env env, const D3d11Frame& frame) {
  auto result = Napi::Object::New(env);
  auto key = Napi::Object::New(env);
  key.Set("slot", frame.key.slot);
  key.Set("generation", static_cast<double>(frame.key.generation));
  key.Set("sequence", static_cast<double>(frame.key.sequence));
  result.Set("key", key);
  auto texture = Napi::Object::New(env);
  auto handle = Napi::Object::New(env);
  handle.Set("ntHandle", Napi::Buffer<uint8_t>::Copy(env, reinterpret_cast<const uint8_t*>(&frame.handle), sizeof(HANDLE)));
  texture.Set("handle", handle);
  auto size = Napi::Object::New(env);
  size.Set("width", frame.width);
  size.Set("height", frame.height);
  texture.Set("codedSize", size);
  texture.Set("pixelFormat", "bgra");
  texture.Set("timestamp", frame.target_time_ns / 1000.0);
  auto color = Napi::Object::New(env);
  color.Set("primaries", "bt709");
  color.Set("transfer", "srgb");
  color.Set("matrix", "rgb");
  color.Set("range", "full");
  texture.Set("colorSpace", color);
  result.Set("textureInfo", texture);
  result.Set("targetTimeNs", static_cast<double>(frame.target_time_ns));
  result.Set("clockTimeNs", static_cast<double>(frame.clock_time_ns));
  result.Set("frameFlags", static_cast<double>(frame.frame_flags));
  result.Set("renderSubmissionMs", frame.render_submission_ms);
  result.Set("gpuReadyMs", frame.gpu_ready_ms);
  result.Set("targetWaitMs", frame.target_wait_ms);
  result.Set("gpuExecutionMs", frame.gpu_execution_ms >= 0 ? Napi::Number::New(env, frame.gpu_execution_ms) : env.Null());
  return result;
}

struct D3d11Callbacks : std::enable_shared_from_this<D3d11Callbacks> {
  std::mutex mutex;
  Napi::ThreadSafeFunction event;
  Napi::ThreadSafeFunction update;
  std::atomic<bool> failed{false};
  bool reported = false;
  bool closed = false;
  void close() {
    std::lock_guard<std::mutex> lock(mutex);
    closed = true;
    if (event) { event.Release(); event = nullptr; }
    if (update) { update.Release(); update = nullptr; }
  }
  static void notify(D3d11Callbacks* state, bool is_update) {
    std::lock_guard<std::mutex> lock(state->mutex);
    auto& callback = is_update ? state->update : state->event;
    if (state->closed || state->failed || !callback) return;
    callback.NonBlockingCall([owner = state->shared_from_this()](Napi::Env env, Napi::Function fn) {
      if (!env || fn.IsEmpty()) return;
      {
        std::lock_guard<std::mutex> lock(owner->mutex);
        if (owner->closed || owner->failed) return;
      }
      fn.Call({});
      if (env.IsExceptionPending()) {
        env.GetAndClearPendingException();
        owner->failed = true;
      }
    });
  }
  static void wakeup(void* data) { notify(static_cast<D3d11Callbacks*>(data), false); }
  static void render_update(void* data) { notify(static_cast<D3d11Callbacks*>(data), true); }
};
}  // namespace lampaua
