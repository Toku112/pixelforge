# Integration tests (label integration): the app itself, run headless.

# The app starts, shows its main window and quits cleanly: catches startup crashes, missing libraries and sanitizer
# reports on every platform.
add_test(NAME app_startup COMMAND pf_app --smoke-test)
set_tests_properties(app_startup PROPERTIES
    LABELS integration
    TIMEOUT 60
    ENVIRONMENT "QT_QPA_PLATFORM=offscreen")
if(WIN32)
    # Qt's DLLs are deployed next to the app only by the package target.
    set_property(TEST app_startup APPEND PROPERTY ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:${PF_QT_ROOT}/bin")
endif()
