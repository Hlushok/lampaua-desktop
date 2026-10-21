#include <napi.h>
#include <mpv/client.h>
#include <mpv/render.h>
#include "d3d11_renderer.h"
#include <atomic>
#include <thread>

#if MPV_CLIENT_API_VERSION >= MPV_MAKE_VERSION(2, 6)
#include <mpv/render_d3d11.h>
#endif

namespace lampaua {
namespace {
std::atomic_flag probe_busy = ATOMIC_FLAG_INIT;

struct ProbeResult {
  unsigned long api_version = 0;
  D3d11Stats device;
  std::string error;
  std::string code = "MPV_D3D11_CONTEXT";
  bool render_thread = false;
};

struct MpvContext {
  mpv_handle* handle = nullptr;
  mpv_render_context* context = nullptr;
  ~MpvContext() {
    if (context) mpv_render_context_free(context);
    if (handle) mpv_terminate_destroy(handle);
  }
};

class ProbeWorker : public Napi::AsyncWorker {
 public:
  explicit ProbeWorker(Napi::Env env)
    : Napi::AsyncWorker(env, "MPV D3D11 context probe"), deferred_(Napi::Promise::Deferred::New(env)) {
    const auto caller = std::this_thread::get_id();
    completion_ = thread_.submit([this, caller] {
      result_.render_thread = std::this_thread::get_id() != caller;
      result_.api_version = mpv_client_api_version();
      if (result_.api_version != MPV_MAKE_VERSION(2, 6)) {
        result_.code = "MPV_D3D11_API";
        result_.error = "MPV D3D11 requires runtime client API 2.6";
        return;
      }
#if MPV_CLIENT_API_VERSION >= MPV_MAKE_VERSION(2, 6)
      D3d11FramePool pool;
      if (!pool.initialize(32, 32)) { result_.error = pool.error(); pool.retire(); return; }
      result_.device = pool.stats();
      {
        MpvContext mpv;
        mpv.handle = mpv_create();
        if (!mpv.handle) result_.error = "mpv_create failed";
        if (mpv.handle) {
          const char* settings[][2] = {{"config", "no"}, {"terminal", "no"}, {"vo", "libmpv"}, {"ao", "null"}};
          for (const auto& option : settings) {
            int status = mpv_set_option_string(mpv.handle, option[0], option[1]);
            if (status < 0) { result_.error = std::string(option[0]) + ": " + mpv_error_string(status); break; }
          }
          if (result_.error.empty()) {
            int status = mpv_initialize(mpv.handle);
            if (status < 0) result_.error = std::string("mpv_initialize: ") + mpv_error_string(status);
          }
          if (result_.error.empty()) {
            mpv_d3d11_init_params init{pool.device()};
            mpv_render_param params[] = {
              {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(MPV_RENDER_API_TYPE_D3D11)},
              {MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &init},
              {MPV_RENDER_PARAM_INVALID, nullptr},
            };
            int status = mpv_render_context_create(&mpv.context, mpv.handle, params);
            if (status < 0) result_.error = std::string("D3D11 render context: ") + mpv_error_string(status);
          }
        }
      }
      pool.retire();
#else
      result_.code = "MPV_D3D11_HEADERS";
      result_.error = "MPV D3D11 requires SDK headers with client API 2.6";
#endif
    });
  }
  ~ProbeWorker() { probe_busy.clear(); }
  Napi::Promise promise() { return deferred_.Promise(); }
  void Execute() override {
    if (completion_.valid()) completion_.wait();
    else result_.error = "MPV D3D11 render thread unavailable";
    thread_.stop();
    if (!result_.error.empty()) SetError(result_.error);
  }
  void OnOK() override {
    auto value = Napi::Object::New(Env());
    value.Set("apiVersion", Napi::Number::New(Env(), result_.api_version));
    value.Set("backend", "d3d11");
    value.Set("hardware", result_.device.hardware);
    value.Set("adapterLuid", result_.device.adapter_luid);
    value.Set("renderThread", result_.render_thread);
    deferred_.Resolve(value);
  }
  void OnError(const Napi::Error& error) override {
    error.Set("code", result_.code);
    error.Set("apiVersion", Napi::Number::New(Env(), result_.api_version));
    deferred_.Reject(error.Value());
  }
 private:
  Napi::Promise::Deferred deferred_;
  D3d11RenderThread thread_;
  ProbeResult result_;
  std::future<void> completion_;
};
}  // namespace

void RegisterD3d11ContextProbe(Napi::Env env, Napi::Object exports) {
  exports.Set("probeD3d11Context", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    if (probe_busy.test_and_set()) {
      auto promise = Napi::Promise::Deferred::New(info.Env());
      promise.Reject(Napi::Error::New(info.Env(), "MPV D3D11 probe is already active").Value());
      return promise.Promise();
    }
    auto* worker = new ProbeWorker(info.Env());
    auto promise = worker->promise();
    worker->Queue();
    return promise;
  }));
}
}  // namespace lampaua
