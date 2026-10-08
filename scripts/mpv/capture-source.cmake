function(lampaua_capture_source name)
    get_property(repo TARGET ${name} PROPERTY _EP_GIT_REPOSITORY)
    get_property(url TARGET ${name} PROPERTY _EP_URL)
    get_property(hash TARGET ${name} PROPERTY _EP_URL_HASH)
    get_property(source TARGET ${name} PROPERTY _EP_SOURCE_DIR)
    get_property(dependencies TARGET ${name} PROPERTY _EP_DEPENDS)
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
    file(WRITE "$ENV{LAMPAUA_MPV_SOURCES}/projects/${name}.json"
        "{\"name\":\"${name}\",\"hasSource\":${has_source},\"dependencies\":[${dependency_json}]}\n")
    if(NOT has_source)
        return()
    endif()
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
endfunction()
