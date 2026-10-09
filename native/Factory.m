// Keep a native, signed parent alive for the entire background service lifetime.
// The private runtime manifest lives outside the signed app, so selecting a new
// release does not change the identity macOS associates with its children.
#import <Foundation/Foundation.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
static volatile sig_atomic_t child = 0;
static const int forwarded[] = { SIGTERM, SIGINT, SIGHUP, SIGQUIT };

static void forward(int signal) {
  pid_t pid = child;
  if (pid > 0) kill(pid, signal);
}

static int fail(NSString *message) {
  fprintf(stderr, "Kipster Software Factory: %s\n", message.UTF8String);
  return 78;
}

static BOOL owned(const char *path, BOOL directory, mode_t forbidden) {
  struct stat info;
  return lstat(path, &info) == 0 && info.st_uid == getuid() &&
    (directory ? S_ISDIR(info.st_mode) : S_ISREG(info.st_mode)) &&
    (info.st_mode & forbidden) == 0;
}

static int launch(int argc, const char *argv[]) {
  if (argc != 3 || strcmp(argv[1], "--home") != 0)
    return fail(@"usage: Factory --home <absolute factory home>");
  NSString *home = @(argv[2]);
  if (!home.isAbsolutePath || [home.pathComponents containsObject:@".."] ||
      !owned(home.fileSystemRepresentation, YES, 022))
    return fail(@"The factory home must be an absolute directory owned by this user and not writable by other users.");
  NSString *service = [home stringByAppendingPathComponent:@"service"];
  NSString *manifest = [service stringByAppendingPathComponent:@"runtime.json"];
  if (!owned(service.fileSystemRepresentation, YES, 077) ||
      !owned(manifest.fileSystemRepresentation, NO, 077))
    return fail(@"The service runtime is missing or is not private. Run kf start to prepare it.");
  NSData *bytes = [NSData dataWithContentsOfFile:manifest];
  id parsed = bytes.length && bytes.length <= 65536
    ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
  NSDictionary *runtime = [parsed isKindOfClass:NSDictionary.class] ? parsed : nil;
  NSString *node = runtime[@"node"], *cli = runtime[@"cli"];
  if (![runtime[@"version"] isEqual:@1] ||
      ![node isKindOfClass:NSString.class] || !node.isAbsolutePath ||
      ![cli isKindOfClass:NSString.class] || !cli.isAbsolutePath ||
      access(node.fileSystemRepresentation, X_OK) != 0 ||
      access(cli.fileSystemRepresentation, R_OK) != 0)
    return fail(@"The service runtime is invalid or unavailable. Run kf start with an installed release.");

  char *arguments[] = { (char *)node.fileSystemRepresentation,
    (char *)cli.fileSystemRepresentation, "serve", "--home",
    (char *)home.fileSystemRepresentation, NULL };
  sigset_t blocked, empty, defaults;
  sigemptyset(&blocked); sigemptyset(&empty); sigemptyset(&defaults);
  for (size_t i = 0; i < sizeof forwarded / sizeof forwarded[0]; i++) {
    sigaddset(&blocked, forwarded[i]); sigaddset(&defaults, forwarded[i]);
  }
  sigaddset(&defaults, SIGPIPE);
  sigprocmask(SIG_BLOCK, &blocked, NULL);
  for (size_t i = 0; i < sizeof forwarded / sizeof forwarded[0]; i++) {
    struct sigaction action = { 0 };
    action.sa_handler = forward;
    action.sa_flags = SA_RESTART;
    sigemptyset(&action.sa_mask);
    sigaction(forwarded[i], &action, NULL);
  }
  posix_spawnattr_t attributes;
  posix_spawnattr_init(&attributes);
  posix_spawnattr_setsigmask(&attributes, &empty);
  posix_spawnattr_setsigdefault(&attributes, &defaults);
  posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  pid_t pid = 0;
  int error = posix_spawn(&pid, arguments[0], NULL, &attributes, arguments, environ);
  posix_spawnattr_destroy(&attributes);
  if (error != 0) return fail([NSString stringWithFormat:@"Cannot start Node: %s", strerror(error)]);
  child = pid;
  sigprocmask(SIG_UNBLOCK, &blocked, NULL);
  int status = 0;
  while (waitpid(pid, &status, 0) < 0)
    if (errno != EINTR) return fail(@"Lost the factory process.");
  child = 0;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 71;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool { return launch(argc, argv); }
}
