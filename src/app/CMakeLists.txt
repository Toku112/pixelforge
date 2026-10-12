qt_add_executable(pf_app MACOSX_BUNDLE WIN32
    main.cpp)
pf_target_defaults(pf_app)
target_link_libraries(pf_app PRIVATE pf_engine Qt6::Core Qt6::Gui Qt6::Widgets)
target_compile_definitions(pf_app PRIVATE PF_VERSION_STRING="${PROJECT_VERSION}")

set_target_properties(pf_app PROPERTIES
    OUTPUT_NAME "${PF_APP_NAME}"
    MACOSX_BUNDLE_BUNDLE_NAME "${PF_APP_NAME}"
    MACOSX_BUNDLE_GUI_IDENTIFIER "${PF_APP_BUNDLE_ID}"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
    MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}")
