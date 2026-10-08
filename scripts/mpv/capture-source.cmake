function(lampaua_capture_source name)
    get_property(repo TARGET ${name} PROPERTY _EP_GIT_REPOSITORY)
    get_property(url TARGET ${name} PROPERTY _EP_URL)
    get_property(hash TARGET ${name} PROPERTY _EP_URL_HASH)
    get_property(source TARGET ${name} PROPERTY _EP_SOURCE_DIR)
    if(NOT repo AND NOT url)
        return()
    endif()
    file(MAKE_DIRECTORY "$ENV{LAMPAUA_MPV_SOURCES}/projects")
    file(WRITE "$ENV{LAMPAUA_MPV_SOURCES}/projects/${name}.json"
        "{\"name\":\"${name}\",\"repository\":\"${repo}\",\"url\":\"${url}\"}\n")
    ExternalProject_Add_Step(${name} lampaua-source
        DEPENDEES download
        DEPENDERS patch
        INDEPENDENT TRUE
        COMMAND python3 "$ENV{LAMPAUA_MPV_SCRIPTS}/capture_source.py"
            --name "${name}" --source "${source}"
            --repository "${repo}" --url "${url}" --url-hash "${hash}"
            --output "$ENV{LAMPAUA_MPV_SOURCES}"
        LOG TRUE
        COMMENT "Preserving exact unpatched sources: ${name}"
    )
endfunction()
