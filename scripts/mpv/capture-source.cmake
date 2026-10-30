function(lampaua_capture_source name)
    get_property(repo TARGET ${name} PROPERTY _EP_GIT_REPOSITORY)
    get_property(url TARGET ${name} PROPERTY _EP_URL)
    get_property(hash TARGET ${name} PROPERTY _EP_URL_HASH)
    get_property(source TARGET ${name} PROPERTY _EP_SOURCE_DIR)
    get_property(revision TARGET ${name} PROPERTY _EP_GIT_TAG)
    get_property(reset TARGET ${name} PROPERTY _EP_GIT_RESET)
    if(reset)
        set(revision "${reset}")
    endif()
    get_property(dependencies TARGET ${name} PROPERTY _EP_DEPENDS)
    get_property(configure_command TARGET ${name} PROPERTY _EP_CONFIGURE_COMMAND)
    set(configure_json "")
    foreach(argument IN LISTS configure_command)
        string(REPLACE "\\" "\\\\" argument "${argument}")
        string(REPLACE "\"" "\\\"" argument "${argument}")
        string(REPLACE "\n" "\\n" argument "${argument}")
        string(REPLACE "\r" "\\r" argument "${argument}")
        string(REPLACE "\t" "\\t" argument "${argument}")
        if(NOT configure_json STREQUAL "")
            string(APPEND configure_json ",")
        endif()
        string(APPEND configure_json "\"${argument}\"")
    endforeach()
    set(dependency_json "")
    foreach(dependency IN LISTS dependencies)
        if(NOT dependency_json STREQUAL "")
            string(APPEND dependency_json ",")
        endif()
        string(APPEND dependency_json "\"${dependency}\"")
    endforeach()
    set(has_source false)
    if(repo OR url)
        set(has_source true)
    endif()
    file(MAKE_DIRECTORY "$ENV{LAMPAUA_MPV_SOURCES}/projects")
    foreach(field repo url hash source revision)
        string(REPLACE "\\" "\\\\" ${field} "${${field}}")
        string(REPLACE "\"" "\\\"" ${field} "${${field}}")
    endforeach()
    file(WRITE "$ENV{LAMPAUA_MPV_SOURCES}/projects/${name}.json"
        "{\"name\":\"${name}\",\"hasSource\":${has_source},\"dependencies\":[${dependency_json}],\"configureCommand\":[${configure_json}],\"repository\":\"${repo}\",\"revision\":\"${revision}\",\"url\":\"${url}\",\"urlHash\":\"${hash}\",\"source\":\"${source}\"}\n")
    if(NOT has_source)
        return()
    endif()
    # Keep command paths separate from their JSON-escaped representation.
    get_property(repo TARGET ${name} PROPERTY _EP_GIT_REPOSITORY)
    get_property(url TARGET ${name} PROPERTY _EP_URL)
    get_property(hash TARGET ${name} PROPERTY _EP_URL_HASH)
    get_property(source TARGET ${name} PROPERTY _EP_SOURCE_DIR)
    ExternalProject_Add_Step(${name} lampaua-source
        DEPENDEES download
        DEPENDERS patch
        INDEPENDENT TRUE
        COMMAND python3 "$ENV{LAMPAUA_MPV_SCRIPTS}/capture_source.py"
            --name "${name}" --source "${source}"
            "--repository=${repo}" "--url=${url}" "--url-hash=${hash}"
            --output "$ENV{LAMPAUA_MPV_SOURCES}"
        LOG TRUE
        COMMENT "Preserving exact unpatched sources: ${name}"
    )
    ExternalProject_Add_StepTargets(${name} lampaua-source)
endfunction()
